import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import {
  buildRealtimeVoiceAgentCancelProviderResult,
  buildRealtimeVoiceAgentConsultWorkingResponse,
  consultRealtimeVoiceAgent,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  resolveRealtimeVoiceAgentConsultToolsAllow,
  type RealtimeVoiceBridgeSession,
  type RealtimeVoiceTranscriptEntry,
  type RealtimeVoiceToolCallEvent,
  type TalkEventInput,
} from "openclaw/plugin-sdk/realtime-voice";
import type { FaceTimeConfig } from "./config.js";
import {
  AGENT_CONSULT_MESSAGE_PROVIDER,
  CONSULT_SYSTEM_PROMPT,
  FACETIME_END_CALL_TOOL_NAME,
} from "./talk-driver-config.js";

type PendingAgentConsult = {
  callId: string;
  turnId: string;
  name: string;
  cancelRequested: boolean;
  terminalSubmitted: boolean;
  generation: number;
  abortController: AbortController;
  runRegistration?: { runId: string; controller: AbortController };
};

export function createFaceTimeConsultController(params: {
  config: FaceTimeConfig;
  fullConfig: OpenClawConfig;
  runtime: PluginRuntime;
  logger: RuntimeLogger;
  consultAgentId: string;
  consultSessionKey: string;
  requesterSessionKey: string;
  normalizedCallUUID: string;
  senderId: string;
  senderIsOwner: true;
  transcript: RealtimeVoiceTranscriptEntry[];
  getBridge: () => RealtimeVoiceBridgeSession | undefined;
  getGeneration: () => number;
  isUnavailable: () => boolean;
  ensureTurn: () => string;
  remember: (input: TalkEventInput) => void;
  suspendMedia: (reason: string) => Promise<void>;
  reportFailure: (error: Error) => Promise<boolean>;
  close: (reason: string) => Promise<void>;
  onHangupRequested: () => Promise<void>;
}) {
  const pending = new Map<string, PendingAgentConsult>();
  let hangupRequested = false;

  const ownsConsult = (consult: PendingAgentConsult) =>
    pending.get(consult.callId) === consult &&
    consult.generation === params.getGeneration() &&
    !params.isUnavailable();
  const failDelivery = async (
    event: { callId: string; name: string; turnId?: string },
    error: unknown,
    reason: string,
  ) => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    params.remember({
      type: "tool.error",
      turnId: event.turnId,
      callId: event.callId,
      payload: { name: event.name, error: formatErrorMessage(normalized) },
      final: true,
    });
    try {
      await params.suspendMedia(reason);
      if (await params.reportFailure(normalized)) {
        await params.close(reason);
      }
    } catch (failure) {
      params.logger.warn?.(
        `[facetime] tool delivery recovery failed: ${formatErrorMessage(failure)}`,
      );
    }
  };

  const abortConsult = (consult: PendingAgentConsult, reason: string) => {
    consult.abortController.abort(new Error(`FaceTime agent consult ${reason}`));
    consult.runRegistration?.controller.abort(new Error(`FaceTime agent consult run ${reason}`));
  };
  const abortForClose = () => {
    for (const consult of pending.values()) {
      consult.cancelRequested = true;
      pending.delete(consult.callId);
      abortConsult(consult, "closed or reset");
    }
  };
  const cancelPending = () => {
    for (const consult of pending.values()) {
      if (consult.cancelRequested) {
        continue;
      }
      consult.cancelRequested = true;
      abortConsult(consult, "superseded");
      // A terminal write may already have reached the provider. Never submit a
      // second terminal result while its acknowledgement is pending.
      if (consult.terminalSubmitted) {
        continue;
      }
      consult.terminalSubmitted = true;
      const result = buildRealtimeVoiceAgentCancelProviderResult(
        "A new agent consult replaced this request before it completed.",
      );
      void (async () => {
        try {
          const bridge = params.getBridge();
          if (!bridge) {
            throw new Error("Realtime bridge unavailable during agent consult cancellation");
          }
          const options =
            bridge.bridge.supportsToolResultSuppression === false
              ? undefined
              : { suppressResponse: true };
          await bridge.submitToolResult(consult.callId, result, options);
          if (!ownsConsult(consult)) {
            return;
          }
          pending.delete(consult.callId);
          params.remember({
            type: "tool.result",
            turnId: consult.turnId,
            callId: consult.callId,
            payload: { name: consult.name, result },
            final: true,
          });
        } catch (error) {
          if (!ownsConsult(consult)) {
            return;
          }
          pending.delete(consult.callId);
          await failDelivery(consult, error, "consult-cancel-failed");
        }
      })();
    }
  };
  const submitHangupResult = async (event: RealtimeVoiceToolCallEvent) => {
    const bridge = params.getBridge();
    const callId = event.callId || event.itemId;
    const turnId = params.ensureTurn();
    const result = {
      status: "ending",
      message: "The current FaceTime call is ending. Do not speak another response.",
    };
    params.remember({
      type: "tool.call",
      turnId,
      itemId: event.itemId,
      callId,
      payload: { name: event.name, args: event.args },
    });
    try {
      const options =
        bridge?.bridge.supportsToolResultSuppression === false
          ? undefined
          : { suppressResponse: true };
      await bridge?.submitToolResult(callId, result, options);
      params.remember({
        type: "tool.result",
        turnId,
        callId,
        payload: { name: event.name, result },
        final: true,
      });
    } catch (error) {
      const message = formatErrorMessage(error);
      params.logger.debug?.(`[facetime] hangup tool result ignored: ${message}`);
      params.remember({
        type: "tool.error",
        turnId,
        callId,
        payload: { name: event.name, error: message },
        final: true,
      });
    }
  };
  const submitToolError = async (event: RealtimeVoiceToolCallEvent, error: string) => {
    const callId = event.callId || event.itemId;
    const generation = params.getGeneration();
    params.remember({
      type: "tool.error",
      callId,
      payload: { name: event.name, error },
      final: true,
    });
    try {
      const bridge = params.getBridge();
      if (!bridge) {
        throw new Error("Realtime bridge unavailable during tool error delivery");
      }
      await bridge.submitToolResult(callId, { error });
    } catch (failure) {
      if (generation === params.getGeneration() && !params.isUnavailable()) {
        await failDelivery({ callId, name: event.name }, failure, "tool-error-delivery-failed");
      }
    }
  };
  const handleToolCall = async (event: RealtimeVoiceToolCallEvent) => {
    if (params.isUnavailable()) {
      return;
    }
    const callId = event.callId || event.itemId;
    if (event.name === FACETIME_END_CALL_TOOL_NAME) {
      const shouldRequestHangup = !hangupRequested;
      hangupRequested = true;
      await submitHangupResult(event);
      if (shouldRequestHangup) {
        try {
          await params.onHangupRequested();
        } catch (error) {
          params.logger.warn?.(
            `[facetime] caller-requested hangup remains pending: ${formatErrorMessage(error)}`,
          );
        }
      }
      return;
    }
    if (event.name !== REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME) {
      await submitToolError(event, `Tool "${event.name}" not available`);
      return;
    }
    // Caller speech can be a clarification or a request for progress. Keep the
    // current task alive until the realtime model actually requests a new
    // agent consult, which is the unambiguous replacement boundary.
    cancelPending();
    const turnId = params.ensureTurn();
    const consult: PendingAgentConsult = {
      callId,
      turnId,
      name: event.name,
      cancelRequested: false,
      terminalSubmitted: false,
      generation: params.getGeneration(),
      abortController: new AbortController(),
    };
    pending.set(callId, consult);
    params.remember({
      type: "tool.call",
      turnId,
      itemId: event.itemId,
      callId,
      payload: { name: event.name, args: event.args },
    });
    params.remember({
      type: "tool.progress",
      turnId,
      callId,
      payload: { name: event.name, status: "working" },
    });
    const bridge = params.getBridge();
    if (bridge?.bridge.supportsToolResultContinuation) {
      try {
        await bridge.submitToolResult(
          callId,
          buildRealtimeVoiceAgentConsultWorkingResponse("caller"),
          {
            willContinue: true,
          },
        );
      } catch (error) {
        if (ownsConsult(consult) && !consult.cancelRequested) {
          pending.delete(callId);
          await failDelivery(consult, error, "consult-working-delivery-failed");
        }
        return;
      }
      if (!ownsConsult(consult) || consult.cancelRequested) {
        return;
      }
    }
    const deliverResult = async (result: unknown, backendError?: string) => {
      if (!ownsConsult(consult) || consult.cancelRequested) {
        return;
      }
      consult.terminalSubmitted = true;
      try {
        const currentBridge = params.getBridge();
        if (!currentBridge) {
          throw new Error("Realtime bridge unavailable during agent consult delivery");
        }
        await currentBridge.submitToolResult(callId, result);
      } catch (error) {
        if (ownsConsult(consult)) {
          pending.delete(callId);
          await failDelivery(consult, error, "consult-result-delivery-failed");
        }
        return;
      }
      if (!ownsConsult(consult)) {
        return;
      }
      pending.delete(callId);
      params.remember({
        type: backendError === undefined ? "tool.result" : "tool.error",
        turnId,
        callId,
        payload:
          backendError === undefined
            ? { name: event.name, result }
            : { name: event.name, error: backendError },
        final: true,
      });
    };
    void consultRealtimeVoiceAgent({
      cfg: params.fullConfig,
      agentRuntime: params.runtime.agent,
      logger: params.logger,
      agentId: params.consultAgentId,
      sessionKey: params.consultSessionKey,
      spawnedBy: params.requesterSessionKey,
      senderId: params.senderId,
      senderIsOwner: params.senderIsOwner,
      contextMode: "fork",
      messageProvider: AGENT_CONSULT_MESSAGE_PROVIDER,
      lane: `facetime:${params.normalizedCallUUID}`,
      runIdPrefix: `facetime:${params.normalizedCallUUID}`,
      args: event.args,
      transcript: params.transcript,
      surface: "a private FaceTime call",
      userLabel: "Caller",
      assistantLabel: "Assistant",
      questionSourceLabel: "caller",
      toolsAllow: resolveRealtimeVoiceAgentConsultToolsAllow(params.config.realtime.toolPolicy),
      extraSystemPrompt: CONSULT_SYSTEM_PROMPT,
      thinkLevel: "off",
      abortSignal: consult.abortController.signal,
      onRunStarted: ({ runId }) => {
        const registration = { runId, controller: new AbortController() };
        consult.runRegistration = registration;
        if (consult.cancelRequested || pending.get(consult.callId) !== consult) {
          registration.controller.abort(new Error("FaceTime agent consult was already cancelled"));
        }
        return {
          abortSignal: registration.controller.signal,
          cleanup: () => {
            if (consult.runRegistration === registration) {
              consult.runRegistration = undefined;
            }
          },
        };
      },
    }).then(
      (result) => deliverResult(result),
      (error: unknown) => {
        if (!ownsConsult(consult) || consult.cancelRequested) {
          return;
        }
        const message = formatErrorMessage(error);
        params.logger.warn?.(`[facetime] agent consult failed: ${message}`);
        return deliverResult({ error: message }, message);
      },
    );
  };
  return { abortForClose, handleToolCall };
}
