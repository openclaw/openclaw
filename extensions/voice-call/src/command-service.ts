// Voice Call command service owns operations shared by gateway and model-tool adapters.
import { timestampMsToIsoString } from "openclaw/plugin-sdk/number-runtime";
import type { CallMode } from "./config.js";
import type { VoiceCallRuntime } from "./runtime.js";
import type { CallRecord } from "./types.js";

export class VoiceCallCommandInputError extends Error {}

type VoiceCallCommandRuntimeSelectors = {
  ensureRuntimeForExistingCall: () => Promise<VoiceCallRuntime>;
  ensureRuntimeForNewCall: () => Promise<VoiceCallRuntime>;
  assertCurrentRegistration: () => void;
};

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

export function createVoiceCallCommandService({
  ensureRuntimeForExistingCall,
  ensureRuntimeForNewCall,
  assertCurrentRegistration,
}: VoiceCallCommandRuntimeSelectors) {
  const isCurrentRegistration = (): boolean => {
    try {
      assertCurrentRegistration();
      return true;
    } catch {
      return false;
    }
  };

  const describeHistoricalCall = async (rt: VoiceCallRuntime, callId: string) => {
    assertCurrentRegistration();
    const call = await rt.manager.getCallFromMemoryOrStore(callId);
    assertCurrentRegistration();
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
    const rt = await ensureRuntimeForExistingCall();
    assertCurrentRegistration();
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
        assertCurrentRegistration();
        const result = await request.rt.manager.continueCall(request.callId, request.message, {
          isCurrent: isCurrentRegistration,
        });
        requireSuccess(result, "continue failed");
        return { success: true as const, transcript: result.transcript };
      },
    };
  };

  return {
    prepareContinue,

    async initiate(
      params: {
        to?: string;
        message?: string;
        mode?: CallMode;
        sessionKey?: string;
        dtmfSequence?: string;
        requesterSessionKey?: string;
        agentId?: string;
      },
      missingToMessage = "to required",
    ) {
      const rt = await ensureRuntimeForNewCall();
      const to = requireInput(params.to ?? rt.config.toNumber, missingToMessage);
      assertCurrentRegistration();
      const result = await rt.manager.initiateCall(
        to,
        params.sessionKey,
        {
          message: params.message,
          mode: params.mode,
          dtmfSequence: params.dtmfSequence,
          ...(params.requesterSessionKey
            ? { requesterSessionKey: params.requesterSessionKey }
            : {}),
          ...(params.agentId ? { agentId: params.agentId } : {}),
        },
        { isCurrent: isCurrentRegistration },
      );
      requireSuccess(result, "initiate failed");
      return { callId: result.callId, initiated: true };
    },

    async continueCall(callId?: string, message?: string) {
      return await (await prepareContinue(callId, message)).run();
    },

    async speak(params: { callId?: string; message?: string; allowTwimlFallback?: boolean }) {
      const request = await resolveCallMessage(params.callId, params.message);
      assertCurrentRegistration();
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
      const result = await request.rt.manager.speak(request.callId, request.message, {
        isCurrent: isCurrentRegistration,
      });
      requireSuccess(result, "speak failed");
      return { success: true };
    },

    async sendDtmf(callId?: string, digits?: string) {
      const resolvedCallId = requireInput(callId, "callId and digits required");
      const resolvedDigits = requireInput(digits, "callId and digits required");
      const rt = await ensureRuntimeForExistingCall();
      assertCurrentRegistration();
      const result = await rt.manager.sendDtmf(resolvedCallId, resolvedDigits);
      requireSuccess(result, "dtmf failed");
      return { success: true };
    },

    async endCall(callId?: string) {
      const resolvedCallId = requireInput(callId, "callId required");
      const rt = await ensureRuntimeForExistingCall();
      assertCurrentRegistration();
      const result = await rt.manager.endCall(resolvedCallId);
      requireSuccess(result, "end failed");
      return { success: true };
    },

    async status(callId?: string) {
      const rt = await ensureRuntimeForExistingCall();
      assertCurrentRegistration();
      if (!callId) {
        return { found: true, calls: rt.manager.getActiveCalls().map(toVoiceCallStatus) };
      }
      const call = await rt.manager.getCallFromMemoryOrStore(callId);
      assertCurrentRegistration();
      return call ? { found: true, call: toVoiceCallStatus(call) } : { found: false };
    },
  };
}
