// Voice Call command service owns operations shared by gateway and model-tool adapters.
import { timestampMsToIsoString } from "openclaw/plugin-sdk/number-runtime";
import { CallBriefSchema } from "./call-brief.js";
import type { VoiceCallRuntime } from "./runtime.js";
import { TerminalStates, type CallRecord, type OutboundCallOptions } from "./types.js";

export class VoiceCallCommandInputError extends Error {}

function toVoiceCallStatus(call: CallRecord) {
  return {
    callId: call.callId,
    ...(call.providerCallId !== undefined ? { providerCallId: call.providerCallId } : {}),
    provider: call.provider,
    direction: call.direction,
    state: call.state,
    startedAt: call.startedAt,
    ...(call.answeredAt !== undefined ? { answeredAt: call.answeredAt } : {}),
    ...(call.endedAt !== undefined ? { endedAt: call.endedAt } : {}),
    ...(call.endReason !== undefined ? { endReason: call.endReason } : {}),
  };
}

function requireInput(value: string | undefined, message: string): string {
  if (!value) {
    throw new VoiceCallCommandInputError(message);
  }
  return value;
}

function requireSuccess(result: { success: boolean; error?: string }, fallback: string): void {
  if (!result.success) {
    throw new Error(result.error || fallback);
  }
}

export function createVoiceCallCommandService(ensureRuntime: () => Promise<VoiceCallRuntime>) {
  const describeHistoricalCall = async (rt: VoiceCallRuntime, callId: string) => {
    const call = await rt.manager.getCallFromMemoryOrStore(callId);
    if (!call) {
      return undefined;
    }
    const endedAt = timestampMsToIsoString(call.endedAt);
    const details = [
      `last state=${call.state}`,
      call.endReason ? `endReason=${call.endReason}` : undefined,
      endedAt ? `endedAt=${endedAt}` : undefined,
    ].filter(Boolean);
    return `call is not active (${details.join(", ")})`;
  };

  const resolveCallMessage = async (callId?: string, message?: string) => {
    const resolvedCallId = requireInput(callId, "callId and message required");
    const resolvedMessage = requireInput(message, "callId and message required");
    const rt = await ensureRuntime();
    const activeCall =
      rt.manager.getCall(resolvedCallId) ?? rt.manager.getCallByProviderCallId(resolvedCallId);
    if (!activeCall) {
      throw new VoiceCallCommandInputError(
        (await describeHistoricalCall(rt, resolvedCallId)) ?? "Call not found",
      );
    }
    return { rt, callId: activeCall.callId, message: resolvedMessage };
  };

  const prepareContinue = async (callId?: string, message?: string) => {
    const request = await resolveCallMessage(callId, message);
    return {
      rt: request.rt,
      run: async () => {
        const result = await request.rt.manager.continueCall(request.callId, request.message);
        requireSuccess(result, "continue failed");
        return { success: true as const, transcript: result.transcript };
      },
    };
  };

  return {
    prepareContinue,

    async initiate(
      params: Omit<OutboundCallOptions, "brief"> & {
        to?: string;
        sessionKey?: string;
        /** Untrusted brief input; validated against the call brief schema below. */
        brief?: unknown;
      },
      missingToMessage = "to required",
    ) {
      const rt = await ensureRuntime();
      const to = requireInput(params.to ?? rt.config.toNumber, missingToMessage);
      const parsedBrief = CallBriefSchema.optional().safeParse(params.brief);
      if (!parsedBrief.success) {
        throw new VoiceCallCommandInputError(`Invalid brief: ${parsedBrief.error.message}`);
      }
      const result = await rt.manager.initiateCall(to, params.sessionKey, {
        message: params.message,
        mode: params.mode,
        brief: parsedBrief.data,
        dtmfSequence: params.dtmfSequence,
        ...(params.requesterSessionKey ? { requesterSessionKey: params.requesterSessionKey } : {}),
        ...(params.agentId ? { agentId: params.agentId } : {}),
      });
      requireSuccess(result, "initiate failed");
      return { callId: result.callId, initiated: true };
    },

    async continueCall(callId?: string, message?: string) {
      return await (await prepareContinue(callId, message)).run();
    },

    async steer(params: {
      callId?: string;
      message?: string;
      mode?: "say" | "guidance";
      requesterSessionKey?: string;
      operator?: boolean;
      assertCurrent?: () => void;
    }) {
      const callId = requireInput(params.callId, "callId and message required");
      const message = requireInput(params.message?.trim(), "callId and message required");
      if (message.length > 500) {
        throw new VoiceCallCommandInputError("Steering message must be at most 500 characters");
      }
      const rt = await ensureRuntime();
      params.assertCurrent?.();
      const call = rt.manager.getCall(callId);
      if (!call || TerminalStates.has(call.state)) {
        throw new VoiceCallCommandInputError("Call is not active");
      }
      const requester = call.metadata?.requesterSessionKey;
      if (
        !params.operator &&
        (!params.requesterSessionKey || requester !== params.requesterSessionKey)
      ) {
        throw new VoiceCallCommandInputError(
          "Only the requester session or an operator may steer this call",
        );
      }
      if (!rt.config.realtime.enabled) {
        throw new VoiceCallCommandInputError("Steering requires an active realtime call");
      }
      await rt.manager.updateCallMetadata(
        call,
        (metadata) => ({
          ...metadata,
          ownerInstructions: [
            ...(Array.isArray(metadata?.ownerInstructions) ? metadata.ownerInstructions : []),
            message,
          ].slice(-8),
        }),
        { persist: true, assertCurrent: params.assertCurrent },
      );
      params.assertCurrent?.();
      if (rt.manager.getCall(callId) !== call || TerminalStates.has(call.state)) {
        throw new VoiceCallCommandInputError("Call is not active");
      }
      const instruction =
        params.mode === "say"
          ? `Owner instruction for this call: say this now, verbatim, then listen. Answer: ${JSON.stringify(message)}`
          : `Owner instruction for this call: ${JSON.stringify(message)}. Apply this guidance from now on while respecting the call brief's disclosure and approval limits.`;
      const result = rt.webhookServer.speakRealtime(callId, instruction);
      requireSuccess(result, "Steering failed");
      return { success: true };
    },

    async speak(params: { callId?: string; message?: string; allowTwimlFallback?: boolean }) {
      const request = await resolveCallMessage(params.callId, params.message);
      if (request.rt.config.realtime.enabled) {
        const realtimeResult = request.rt.webhookServer.speakRealtime(
          request.callId,
          request.message,
        );
        if (realtimeResult.success) {
          return { success: true };
        }
        if (params.allowTwimlFallback === false) {
          return {
            success: false,
            error: realtimeResult.error ?? "Realtime bridge is not active",
          };
        }
      }
      const result = await request.rt.manager.speak(request.callId, request.message);
      requireSuccess(result, "speak failed");
      return { success: true };
    },

    async sendDtmf(callId?: string, digits?: string) {
      const resolvedCallId = requireInput(callId, "callId and digits required");
      const resolvedDigits = requireInput(digits, "callId and digits required");
      const rt = await ensureRuntime();
      const result = await rt.manager.sendDtmf(resolvedCallId, resolvedDigits);
      requireSuccess(result, "dtmf failed");
      return { success: true };
    },

    async endCall(
      callId?: string,
      execution?: { runtime?: VoiceCallRuntime; assertAuthority?: () => void },
    ) {
      const resolvedCallId = requireInput(callId, "callId required");
      const rt = execution?.runtime ?? (await ensureRuntime());
      execution?.assertAuthority?.();
      const result = await rt.manager.endCall(resolvedCallId);
      requireSuccess(result, "end failed");
      return { success: true };
    },

    async status(callId?: string) {
      const rt = await ensureRuntime();
      if (!callId) {
        return { found: true, calls: rt.manager.getActiveCalls().map(toVoiceCallStatus) };
      }
      const call = await rt.manager.getCallFromMemoryOrStore(callId);
      return call ? { found: true, call: toVoiceCallStatus(call) } : { found: false };
    },
  };
}
