import crypto from "node:crypto";
import { isAllowlistedCaller, normalizePhoneNumber } from "../allowlist.js";
import type { CallRecord, CallState, NormalizedEvent } from "../types.js";
import type { CallManagerContext } from "./context.js";
import { findCall } from "./lookup.js";
import { endCall } from "./outbound.js";
import { addTranscriptEntry, transitionState } from "./state.js";
import { persistCallRecord } from "./store.js";
import {
  clearMaxDurationTimer,
  rejectTranscriptWaiter,
  resolveTranscriptWaiter,
  startMaxDurationTimer,
} from "./timers.js";

type EventContext = Pick<
  CallManagerContext,
  | "activeCalls"
  | "providerCallIdMap"
  | "processedEventIds"
  | "rejectedProviderCallIds"
  | "provider"
  | "config"
  | "storePath"
  | "transcriptWaiters"
  | "maxDurationTimers"
  | "onCallAnswered"
>;

function shouldAcceptInbound(config: EventContext["config"], from: string | undefined): boolean {
  const { inboundPolicy: policy, allowFrom } = config;

  switch (policy) {
    case "disabled":
      console.log("[voice-call] Inbound call rejected: policy is disabled");
      return false;

    case "open":
      console.log("[voice-call] Inbound call accepted: policy is open");
      return true;

    case "allowlist":
    case "pairing": {
      const normalized = normalizePhoneNumber(from);
      if (!normalized) {
        console.log("[voice-call] Inbound call rejected: missing caller ID");
        return false;
      }
      const allowed = isAllowlistedCaller(normalized, allowFrom);
      const status = allowed ? "accepted" : "rejected";
      console.log(
        `[voice-call] Inbound call ${status}: ${from} ${allowed ? "is in" : "not in"} allowlist`,
      );
      return allowed;
    }

    default:
      return false;
  }
}

function createInboundCall(params: {
  ctx: EventContext;
  providerCallId: string;
  from: string;
  to: string;
}): CallRecord {
  const callId = crypto.randomUUID();

  const callRecord: CallRecord = {
    callId,
    providerCallId: params.providerCallId,
    provider: params.ctx.provider?.name || "twilio",
    direction: "inbound",
    state: "ringing",
    from: params.from,
    to: params.to,
    startedAt: Date.now(),
    transcript: [],
    processedEventIds: [],
    metadata: {
      initialMessage: params.ctx.config.inboundGreeting || "Hello! How can I help you today?",
    },
  };

  params.ctx.activeCalls.set(callId, callRecord);
  params.ctx.providerCallIdMap.set(params.providerCallId, callId);
  persistCallRecord(params.ctx.storePath, callRecord);

  console.log(`[voice-call] Created inbound call record: ${callId} from ${params.from}`);
  return callRecord;
}

export function processEvent(ctx: EventContext, event: NormalizedEvent): void {
  if (ctx.processedEventIds.has(event.id)) {
    return;
  }
  ctx.processedEventIds.add(event.id);

  let call = findCall({
    activeCalls: ctx.activeCalls,
    providerCallIdMap: ctx.providerCallIdMap,
    callIdOrProviderCallId: event.callId,
  });

  if (!call && event.direction === "inbound" && event.providerCallId) {
    if (!shouldAcceptInbound(ctx.config, event.from)) {
      const pid = event.providerCallId;
      if (!ctx.provider) {
        console.warn(
          `[voice-call] Inbound call rejected by policy but no provider to hang up (providerCallId: ${pid}, from: ${event.from}); call will time out on provider side.`,
        );
        return;
      }
      if (ctx.rejectedProviderCallIds.has(pid)) {
        return;
      }
      ctx.rejectedProviderCallIds.add(pid);
      const callId = event.callId ?? pid;
      console.log(`[voice-call] Rejecting inbound call by policy: ${pid}`);
      void ctx.provider
        .hangupCall({
          callId,
          providerCallId: pid,
          reason: "hangup-bot",
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[voice-call] Failed to reject inbound call ${pid}:`, message);
        });
      return;
    }

    call = createInboundCall({
      ctx,
      providerCallId: event.providerCallId,
      from: event.from || "unknown",
      to: event.to || ctx.config.fromNumber || "unknown",
    });

    // Normalize event to internal ID for downstream consumers.
    event.callId = call.callId;
  }

  if (!call) {
    return;
  }

  if (event.providerCallId && event.providerCallId !== call.providerCallId) {
    const previousProviderCallId = call.providerCallId;
    call.providerCallId = event.providerCallId;
    ctx.providerCallIdMap.set(event.providerCallId, call.callId);
    if (previousProviderCallId) {
      const mapped = ctx.providerCallIdMap.get(previousProviderCallId);
      if (mapped === call.callId) {
        ctx.providerCallIdMap.delete(previousProviderCallId);
      }
    }
  }

  call.processedEventIds.push(event.id);

  switch (event.type) {
    case "call.initiated":
      transitionState(call, "initiated");
      break;

    case "call.ringing":
      transitionState(call, "ringing");
      break;

    case "call.answered":
      call.answeredAt = event.timestamp;
      transitionState(call, "answered");
      startMaxDurationTimer({
        ctx,
        callId: call.callId,
        onTimeout: async (callId) => {
          await endCall(ctx, callId);
        },
      });
      ctx.onCallAnswered?.(call);
      break;

    case "call.active":
      transitionState(call, "active");
      break;

    case "call.speaking":
      transitionState(call, "speaking");
      break;

    case "call.speech":
      if (event.isFinal) {
        addTranscriptEntry(call, "user", event.transcript);
        resolveTranscriptWaiter(ctx, call.callId, event.transcript);
      }
      transitionState(call, "listening");
      break;

    case "call.ended":
      call.endedAt = event.timestamp;
      call.endReason = event.reason;
      transitionState(call, event.reason as CallState);
      clearMaxDurationTimer(ctx, call.callId);
      rejectTranscriptWaiter(ctx, call.callId, `Call ended: ${event.reason}`);
      ctx.activeCalls.delete(call.callId);
      if (call.providerCallId) {
        ctx.providerCallIdMap.delete(call.providerCallId);
      }
      break;

    case "call.error":
      if (!event.retryable) {
        call.endedAt = event.timestamp;
        call.endReason = "error";
        transitionState(call, "error");
        clearMaxDurationTimer(ctx, call.callId);
        rejectTranscriptWaiter(ctx, call.callId, `Call error: ${event.error}`);
        ctx.activeCalls.delete(call.callId);
        if (call.providerCallId) {
          ctx.providerCallIdMap.delete(call.providerCallId);
        }
      }
      break;
  }

  persistCallRecord(ctx.storePath, call);
}
