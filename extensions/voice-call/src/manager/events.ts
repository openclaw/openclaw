import crypto from "node:crypto";
import type { CallRecord, CallState, NormalizedEvent } from "../types.js";
import type { CallManagerContext } from "./context.js";
import { isAllowlistedCaller, normalizePhoneNumber } from "../allowlist.js";
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

function shouldAcceptInbound(
  config: CallManagerContext["config"],
  from: string | undefined,
): boolean {
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
  ctx: CallManagerContext;
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

export function processEvent(ctx: CallManagerContext, event: NormalizedEvent): void {
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
      if (ctx.provider && event.providerCallId) {
        void ctx.provider
          .hangupCall({
            callId: event.providerCallId ?? event.callId,
            providerCallId: event.providerCallId,
            reason: "hangup-bot",
          })
          .catch((err) => {
            console.warn(
              `[voice-call] Failed to reject inbound call ${event.providerCallId}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          });
      }
      return;
    }

    call = createInboundCall({
      ctx,
      providerCallId: event.providerCallId,
      from: event.from || "unknown",
      to: event.to || ctx.config.fromNumber || "unknown",
    });
  }

  let evt = event;
  if (call && call.callId !== event.callId) {
    evt = { ...event, callId: call.callId };
  }

  if (!call) {
    return;
  }

  if (evt.providerCallId && !call.providerCallId) {
    call.providerCallId = evt.providerCallId;
    ctx.providerCallIdMap.set(evt.providerCallId, call.callId);
  }

  call.processedEventIds.push(evt.id);

  switch (evt.type) {
    case "call.initiated":
      transitionState(call, "initiated");
      break;

    case "call.ringing":
      transitionState(call, "ringing");
      break;

    case "call.answered":
      call.answeredAt = evt.timestamp;
      transitionState(call, "answered");
      startMaxDurationTimer({
        ctx,
        callId: call.callId,
        onTimeout: async (callId) => {
          await endCall(ctx, callId);
        },
      });
      break;

    case "call.active":
      transitionState(call, "active");
      break;

    case "call.speaking":
      transitionState(call, "speaking");
      break;

    case "call.speech":
      if (evt.isFinal) {
        addTranscriptEntry(call, "user", evt.transcript);
        resolveTranscriptWaiter(ctx, call.callId, evt.transcript);
      }
      transitionState(call, "listening");
      break;

    case "call.ended":
      call.endedAt = evt.timestamp;
      call.endReason = evt.reason;
      transitionState(call, evt.reason as CallState);
      clearMaxDurationTimer(ctx, call.callId);
      rejectTranscriptWaiter(ctx, call.callId, `Call ended: ${evt.reason}`);
      ctx.activeCalls.delete(call.callId);
      if (call.providerCallId) {
        ctx.providerCallIdMap.delete(call.providerCallId);
      }
      break;

    case "call.error":
      if (!evt.retryable) {
        call.endedAt = evt.timestamp;
        call.endReason = "error";
        transitionState(call, "error");
        clearMaxDurationTimer(ctx, call.callId);
        rejectTranscriptWaiter(ctx, call.callId, `Call error: ${evt.error}`);
        ctx.activeCalls.delete(call.callId);
        if (call.providerCallId) {
          ctx.providerCallIdMap.delete(call.providerCallId);
        }
      }
      break;
  }

  persistCallRecord(ctx.storePath, call);
}
