import crypto from "node:crypto";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { redactIdentifier } from "openclaw/plugin-sdk/logging-core";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { isAllowlistedCaller, normalizePhoneNumber } from "../allowlist.js";
import { resolveVoiceCallEffectiveConfig, resolveVoiceCallSessionKey } from "../config.js";
import { TerminalStates, type CallRecord, type NormalizedEvent } from "../types.js";
import { buildCallbackMetadata, findRecentOutboundCallback } from "./callbacks.js";
import type { CallManagerContext } from "./context.js";
import { finalizeCall } from "./lifecycle.js";
import { findCall } from "./lookup.js";
import { endCall } from "./outbound.js";
import { appendCallReplayKey, rememberManagerReplayKey } from "./replay-keys.js";
import { addTranscriptEntry, copyCallRecord, transitionState } from "./state.js";
import { findCallInStore, persistCallRecord } from "./store.js";
import { resolveTranscriptWaiter, startMaxDurationTimer } from "./timers.js";
import { playDetectedCallMessage } from "./voicemail.js";

const log = createSubsystemLogger("voice-call/events");

export type ProcessEventResult =
  | { kind: "ignored"; replayable?: true }
  | { kind: "processed"; replayable?: true }
  | {
      kind: "final-speech";
      call: CallRecord;
      transcript: string;
      waiterResolved: boolean;
    };

function shouldAcceptInbound(
  config: CallManagerContext["config"],
  from: string | undefined,
): boolean {
  const { inboundPolicy: policy, allowFrom } = config;

  switch (policy) {
    case "disabled":
      log.info("Inbound call rejected: policy is disabled");
      return false;

    case "open":
      log.info("Inbound call accepted: policy is open");
      return true;

    case "allowlist":
    case "pairing": {
      const normalized = normalizePhoneNumber(from);
      if (!normalized) {
        log.info("Inbound call rejected: missing caller ID");
        return false;
      }
      const allowed = isAllowlistedCaller(normalized, allowFrom);
      const status = allowed ? "accepted" : "rejected";
      log.info(`Inbound call ${status}: caller=${redactIdentifier(from)} allowlisted=${allowed}`);
      return allowed;
    }

    default:
      return false;
  }
}

export async function processEvent(
  ctx: CallManagerContext,
  event: NormalizedEvent,
): Promise<ProcessEventResult> {
  if (event.type === "call.ended" || (event.type === "call.error" && !event.retryable)) {
    const call =
      findCall({
        activeCalls: ctx.activeCalls,
        providerCallIdMap: ctx.providerCallIdMap,
        callIdOrProviderCallId: event.callId,
      }) ??
      (event.providerCallId
        ? findCall({
            activeCalls: ctx.activeCalls,
            providerCallIdMap: ctx.providerCallIdMap,
            callIdOrProviderCallId: event.providerCallId,
          })
        : undefined);
    // Bridge close emits final transcripts through this same queue, so drain outside it.
    if (call && ctx.beforeCallEnd) {
      try {
        await ctx.beforeCallEnd(call);
      } catch (error) {
        log.warn(
          `Failed to drain final transcript for ${call.callId}: ${formatErrorMessage(error)}`,
        );
      }
    }
  }
  return ctx.mutationQueue.enqueue("state", () => processEventInQueue(ctx, event));
}

async function processEventInQueue(
  ctx: CallManagerContext,
  event: NormalizedEvent,
): Promise<ProcessEventResult> {
  const dedupeKey = event.dedupeKey || event.id;
  if (ctx.processedEventIds.has(dedupeKey)) {
    return { kind: "ignored" };
  }

  let call = findCall({
    activeCalls: ctx.activeCalls,
    providerCallIdMap: ctx.providerCallIdMap,
    callIdOrProviderCallId: event.callId,
  });

  let providerCallId = event.providerCallId;
  let retained: CallRecord | undefined;
  if (!call) {
    retained = await findCallInStore(ctx.storePath, event.callId, ctx.stateRuntime);
    if (!retained && providerCallId && providerCallId !== event.callId) {
      retained = await findCallInStore(ctx.storePath, providerCallId, ctx.stateRuntime);
    }
    // A policy rejection records an attempt, not confirmed carrier termination.
    if (retained && retained.metadata?.rejectionReason !== "inbound-policy") {
      call = ctx.activeCalls.get(retained.callId);
      if (!call) {
        return TerminalStates.has(retained.state)
          ? { kind: "ignored" }
          : { kind: "ignored", replayable: true };
      }
    }
  }
  if (call && providerCallId && providerCallId !== call.providerCallId) {
    const providerOwner =
      providerCallId === event.callId && retained
        ? retained
        : await findCallInStore(ctx.storePath, providerCallId, ctx.stateRuntime);
    // Known aliases cannot replace the live owner's newer provider ID.
    if (providerOwner?.callId === call.callId) {
      providerCallId = call.providerCallId;
    }
  }
  // Auto-register untracked calls arriving via webhook. This covers both
  // true inbound calls and externally-initiated outbound-api calls (e.g. calls
  // placed directly via the Twilio REST API pointing at our webhook URL).
  if (!call && providerCallId && event.direction) {
    // Apply inbound policy for true inbound calls; external outbound-api calls
    // are implicitly trusted because the caller controls the webhook URL.
    const callback =
      event.direction === "inbound" && ctx.config.realtime.enabled
        ? await findRecentOutboundCallback(ctx, event.from)
        : undefined;
    if (
      event.direction === "inbound" &&
      !callback &&
      !shouldAcceptInbound(ctx.config, event.from)
    ) {
      const pid = providerCallId;
      if (!ctx.provider) {
        log.warn(
          `Inbound call rejected by policy but no provider to hang up (providerCallId: ${pid}, caller=${redactIdentifier(event.from)}); call will time out on provider side.`,
        );
        return { kind: "ignored" };
      }
      if (ctx.rejectedProviderCallIds.has(pid)) {
        return { kind: "ignored" };
      }
      const callId = event.callId ?? pid;
      const now = Date.now();
      await persistCallRecord(
        ctx.storePath,
        {
          callId: event.callId || pid,
          providerCallId: pid,
          provider: ctx.provider.name,
          direction: "inbound",
          state: "hangup-bot",
          from: event.from || "unknown",
          to: event.to || ctx.config.fromNumber || "unknown",
          startedAt: event.timestamp || now,
          endedAt: now,
          endReason: "hangup-bot",
          transcript: [],
          processedEventIds: [dedupeKey],
          metadata: { rejectionReason: "inbound-policy" },
        },
        ctx.stateRuntime,
      );
      if (ctx.isStopping()) {
        return { kind: "processed" };
      }
      rememberManagerReplayKey(ctx.rejectedProviderCallIds, pid);
      rememberManagerReplayKey(ctx.processedEventIds, dedupeKey);
      log.info(`Rejecting inbound call by policy: ${pid}`);
      ctx.trackCallWork(
        ctx.provider
          .hangupCall({
            callId,
            providerCallId: pid,
            reason: "hangup-bot",
          })
          .catch((err: unknown) => {
            ctx.rejectedProviderCallIds.delete(pid);
            const message = formatErrorMessage(err);
            log.warn(`Failed to reject inbound call ${pid}: ${message}`);
          }),
      );
      return { kind: "processed" };
    }

    const callId = crypto.randomUUID();
    const from = event.from || "unknown";
    const to = event.to || ctx.config.fromNumber || "unknown";
    const { config: effectiveConfig, numberRouteKey } = resolveVoiceCallEffectiveConfig(
      ctx.config,
      event.direction === "inbound" ? to : undefined,
    );
    const agentId = normalizeAgentId(callback?.agentId ?? effectiveConfig.agentId);
    call = {
      callId,
      providerCallId,
      provider: ctx.provider?.name || "twilio",
      direction: event.direction,
      state: "ringing",
      from,
      to,
      sessionKey: resolveVoiceCallSessionKey({
        config: { ...effectiveConfig, agentId },
        callId,
        phone: event.direction === "outbound" ? to : from,
        coreSession: ctx.coreSession,
      }),
      agentId,
      startedAt: Date.now(),
      transcript: [],
      processedEventIds: [],
      metadata: {
        initialMessage:
          event.direction === "inbound"
            ? effectiveConfig.inboundGreeting || "Hello! How can I help you today?"
            : undefined,
        ...(numberRouteKey ? { numberRouteKey } : {}),
        ...(callback ? buildCallbackMetadata(callback, effectiveConfig) : {}),
      },
    };
    await persistCallRecord(ctx.storePath, call, ctx.stateRuntime);
    ctx.activeCalls.set(callId, call);
    ctx.providerCallIdMap.set(providerCallId, callId);
    log.info(`Created ${event.direction} call record: ${callId} caller=${redactIdentifier(from)}`);
    // Normalize event to internal ID for downstream consumers.
    event.callId = call.callId;
  }

  if (!call) {
    return { kind: "ignored", replayable: true };
  }

  const activeCall = copyCallRecord(call);
  if (event.answeredBy) {
    activeCall.metadata = {
      ...activeCall.metadata,
      answeredByFirst:
        activeCall.metadata?.answeredByFirst ?? activeCall.metadata?.answeredBy ?? event.answeredBy,
      answeredBy: event.answeredBy,
    };
  }
  const previousProviderCallId = call.providerCallId;
  const shouldCommitReplayKey = !(event.type === "call.error" && event.retryable);
  const effects: Array<() => void> = [];
  let result: ProcessEventResult = { kind: "processed" };
  const startDurationTimer = () => {
    startMaxDurationTimer({
      ctx,
      callId: activeCall.callId,
      onTimeout: (callId) => endCall(ctx, callId, { reason: "timeout" }),
    });
  };
  const prepareLiveDurationTimer = () => {
    if (!activeCall.answeredAt) {
      activeCall.answeredAt = event.timestamp;
      effects.push(startDurationTimer);
    }
  };
  const publishProviderCallId = (terminal = false) => {
    if (!providerCallId || providerCallId === previousProviderCallId) {
      return;
    }
    if (!terminal) {
      ctx.providerCallIdMap.set(providerCallId, activeCall.callId);
    }
    if (previousProviderCallId) {
      const mapped = ctx.providerCallIdMap.get(previousProviderCallId);
      if (mapped === activeCall.callId) {
        ctx.providerCallIdMap.delete(previousProviderCallId);
      }
    }
  };

  if (providerCallId && providerCallId !== activeCall.providerCallId) {
    activeCall.providerCallId = providerCallId;
  }
  if (shouldCommitReplayKey) {
    appendCallReplayKey(activeCall.processedEventIds, dedupeKey);
  }

  if (
    event.answeredBy &&
    event.type !== "call.ended" &&
    event.type !== "call.error" &&
    activeCall.direction === "outbound" &&
    ctx.config.voicemail.detection === "twilio" &&
    (activeCall.provider === "twilio" || activeCall.provider === "mock")
  ) {
    const detectedCall = call;
    const machine = event.answeredBy.startsWith("machine_");
    if (machine && !activeCall.metadata?.voicemailStatus) {
      if (ctx.config.voicemail.onMachine === "hang-up") {
        activeCall.metadata = { ...activeCall.metadata, voicemailStatus: "hang-up" };
        delete activeCall.metadata.pendingNotifyAmd;
        effects.push(() =>
          ctx.trackCallWork(endCall(ctx, detectedCall.callId, { reason: "voicemail" })),
        );
      } else if (event.answeredBy.startsWith("machine_end_")) {
        activeCall.metadata = { ...activeCall.metadata, voicemailStatus: "pending" };
        delete activeCall.metadata.pendingNotifyAmd;
        effects.push(() =>
          ctx.trackCallWork(playDetectedCallMessage(ctx, detectedCall, "voicemail")),
        );
      }
    } else if (
      activeCall.metadata?.pendingNotifyAmd &&
      (event.answeredBy === "human" || event.answeredBy === "unknown")
    ) {
      activeCall.metadata = { ...activeCall.metadata, notifyStatus: "pending" };
      delete activeCall.metadata.pendingNotifyAmd;
      effects.push(() => ctx.trackCallWork(playDetectedCallMessage(ctx, detectedCall, "notify")));
    } else if (activeCall.metadata?.pendingNotifyAmd && event.answeredBy === "fax") {
      activeCall.metadata = {
        ...activeCall.metadata,
        notifyStatus: "failed",
        notifyError: "A fax answered the call",
      };
      delete activeCall.metadata.pendingNotifyAmd;
      effects.push(() =>
        ctx.trackCallWork(endCall(ctx, detectedCall.callId, { reason: "failed" })),
      );
    }
  }
  const carrierStatusKey =
    activeCall.metadata?.voicemailStatus === "playing"
      ? "voicemailStatus"
      : activeCall.metadata?.notifyStatus === "playing"
        ? "notifyStatus"
        : undefined;

  switch (event.type) {
    case "call.initiated": {
      transitionState(activeCall, "initiated");
      const inboundProvider = ctx.provider;
      const inboundProviderCallId = activeCall.providerCallId;
      const answerInboundCall = inboundProvider?.answerCall?.bind(inboundProvider);
      if (activeCall.direction === "inbound" && inboundProviderCallId && answerInboundCall) {
        effects.push(() => {
          const inboundStreamSession =
            ctx.config.realtime?.enabled &&
            inboundProvider?.name === "telnyx" &&
            ctx.streamSessionIssuer
              ? ctx.streamSessionIssuer({
                  providerName: "telnyx",
                  callId: activeCall.callId,
                  from: activeCall.from,
                  to: activeCall.to,
                  direction: "inbound",
                })
              : undefined;
          ctx.trackCallWork(
            answerInboundCall({
              callId: activeCall.callId,
              providerCallId: inboundProviderCallId,
              ...(inboundStreamSession
                ? {
                    streamUrl: inboundStreamSession.streamUrl,
                    streamAuthToken: inboundStreamSession.token,
                  }
                : {}),
            }).catch((err: unknown) => {
              const message = formatErrorMessage(err);
              log.warn(`Failed to answer inbound call ${activeCall.providerCallId}: ${message}`);
            }),
          );
        });
      }
      break;
    }

    case "call.ringing":
      transitionState(activeCall, "ringing");
      break;

    case "call.answered":
      activeCall.answeredAt = event.timestamp;
      transitionState(activeCall, "answered");
      effects.push(startDurationTimer, () => ctx.onCallAnswered?.(call));
      break;

    case "call.amd":
      break;

    case "call.active":
      transitionState(activeCall, "active");
      break;

    case "call.speaking":
    case "call.assistant-speech":
      prepareLiveDurationTimer();
      transitionState(activeCall, "speaking");
      if (event.type === "call.assistant-speech" && event.transcript.trim()) {
        addTranscriptEntry(activeCall, "bot", event.transcript);
      }
      break;

    case "call.speech":
      if (event.isFinal && event.transcript.trim()) {
        const waiter = ctx.transcriptWaiters.get(activeCall.callId);
        if (waiter?.turnToken && waiter.turnToken !== event.turnToken) {
          log.warn(`Ignoring speech event with mismatched turn token for ${activeCall.callId}`);
          result = { kind: "ignored" };
          break;
        }
        addTranscriptEntry(activeCall, "user", event.transcript);
        const speechResult: Extract<ProcessEventResult, { kind: "final-speech" }> = {
          kind: "final-speech",
          call,
          transcript: event.transcript,
          waiterResolved: false,
        };
        result = speechResult;
        if (waiter) {
          effects.push(() => {
            if (ctx.transcriptWaiters.get(activeCall.callId) === waiter) {
              speechResult.waiterResolved = resolveTranscriptWaiter(
                ctx,
                activeCall.callId,
                event.transcript,
                event.turnToken,
              );
            }
          });
        }
      }
      if (event.transcript.trim()) {
        effects.push(() => ctx.onCallerSpeech?.(call));
      }
      prepareLiveDurationTimer();
      transitionState(activeCall, "listening");
      break;

    case "call.silence":
    case "call.dtmf":
      break;

    case "call.error":
    case "call.ended":
      if (event.type === "call.error" && event.retryable) {
        // Retryable provider errors remain uncommitted for a later redelivery.
        result = { kind: "processed", replayable: true };
        break;
      }
      if (carrierStatusKey) {
        const errorKey = carrierStatusKey === "voicemailStatus" ? "voicemailError" : "notifyError";
        activeCall.metadata = {
          ...activeCall.metadata,
          [carrierStatusKey]:
            event.type === "call.ended" && event.reason === "completed" ? "left" : "failed",
          ...(event.type === "call.error" ? { [errorKey]: event.error } : {}),
        };
      }
      await finalizeCall({
        ctx,
        call,
        preparedCall: activeCall,
        endReason:
          event.type === "call.error"
            ? "error"
            : event.reason === "completed" && carrierStatusKey === "voicemailStatus"
              ? "voicemail"
              : event.reason,
        endedAt: event.timestamp,
        transcriptRejectReason:
          event.type === "call.error" ? `Call error: ${event.error}` : undefined,
      });
      publishProviderCallId(true);
      rememberManagerReplayKey(ctx.processedEventIds, dedupeKey);
      return { kind: "processed" };
  }

  // Persist reversible call mutations before publishing dedupe, timers, or waiters.
  await persistCallRecord(ctx.storePath, activeCall, ctx.stateRuntime);
  Object.assign(call, activeCall);
  publishProviderCallId();
  if (shouldCommitReplayKey) {
    rememberManagerReplayKey(ctx.processedEventIds, dedupeKey);
  }
  if (!ctx.isStopping()) {
    void ctx.onCallUpdated?.(call);
    for (const effect of effects) {
      effect();
    }
  }
  return result;
}
