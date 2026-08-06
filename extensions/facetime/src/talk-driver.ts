import { abortAgentHarnessRun } from "openclaw/plugin-sdk/agent-harness";
import { resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import { resolveRealtimeBootstrapContextInstructions } from "openclaw/plugin-sdk/realtime-bootstrap-context";
import * as realtimeVoiceSdk from "openclaw/plugin-sdk/realtime-voice";
import {
  buildRealtimeVoiceAgentConsultPolicyInstructions,
  buildRealtimeVoiceAgentCancelProviderResult,
  buildRealtimeVoiceAgentConsultWorkingResponse,
  consultRealtimeVoiceAgent,
  createRealtimeVoiceBridgeSession,
  createTalkSessionController,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  recordTalkObservabilityEvent,
  resolveConfiguredRealtimeVoiceProvider,
  resolveRealtimeVoiceAgentConsultTools,
  resolveRealtimeVoiceAgentConsultToolsAllow,
  type RealtimeVoiceBridgeSession,
  type RealtimeVoiceTool,
  type RealtimeVoiceToolCallEvent,
  type TalkEvent,
  type TalkEventInput,
} from "openclaw/plugin-sdk/realtime-voice";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import { startFaceTimeAudioPump, type FaceTimeAudioPump } from "./audio-pump.js";
import type { FaceTimeConfig } from "./config.js";
import { formatErrorMessage } from "./errors.js";
import {
  PCM16_MONO_24KHZ_BYTES_PER_MILLISECOND,
  resolvePlaybackMediaTimestamp,
} from "./playback-clock.js";

export type FaceTimeTalkDriver = {
  readonly callUUID: string;
  readonly recentTalkEvents: readonly TalkEvent[];
  readyForAudio(): Promise<void>;
  processOutputSuppressed(): boolean;
  realtimeActive(): boolean;
  activate(): void;
  suspendMedia(reason?: string): Promise<void>;
  close(reason?: string): Promise<void>;
};

type TranscriptEntry = { role: "user" | "assistant"; text: string };
type AuthenticatedOwnerConsultParams = Parameters<typeof consultRealtimeVoiceAgent>[0] & {
  senderId: string;
  senderIsOwner: true;
};
type SenderAuthCapableRealtimeVoiceSdk = {
  REALTIME_VOICE_AGENT_CONSULT_SENDER_AUTH_VERSION?: unknown;
};

const CONSULT_SYSTEM_PROMPT = [
  "You are the configured OpenClaw agent receiving a delegated request from an authenticated owner in a private 1:1 FaceTime call.",
  "The authenticated caller is the configured owner/user described by this agent's workspace context, including USER.md. When asked who is speaking, identify them from that workspace context without asking them to reconfirm.",
  "Use the normal workspace, memory, tools, and approval policies for this agent.",
  "Prefer registered OpenClaw tools over exec.",
  "Never claim completion unless the relevant tool result confirms it.",
  "Return a concise, speakable answer suitable for realtime TTS.",
].join(" ");
const INPUT_AUDIO_STATUS_INTERVAL_MS = 1000;
const REALTIME_READY_TIMEOUT_MS = 15_000;
// FaceTime carries audio but is not an OpenClaw message channel. Approval
// followups validate this field, so use the always-registered internal channel.
const AGENT_CONSULT_MESSAGE_PROVIDER = "webchat";
const FACETIME_END_CALL_TOOL_NAME = "facetime_end_call";
const FACETIME_END_CALL_TOOL: RealtimeVoiceTool = {
  type: "function",
  name: FACETIME_END_CALL_TOOL_NAME,
  description:
    "Immediately end the current FaceTime call when the caller clearly asks to hang up, end, leave, or disconnect this call. Do not use this to cancel background work.",
  parameters: {
    type: "object",
    properties: {},
  },
};

function pushRecent(events: TalkEvent[], event: TalkEvent | undefined): void {
  if (!event) {
    return;
  }
  events.push(event);
  if (events.length > 40) {
    events.splice(0, events.length - 40);
  }
}

function assertAuthenticatedSenderConsultSupport(): void {
  const version = (realtimeVoiceSdk as SenderAuthCapableRealtimeVoiceSdk)
    .REALTIME_VOICE_AGENT_CONSULT_SENDER_AUTH_VERSION;
  if (version !== 1) {
    throw new Error(
      "OpenClaw host does not support authenticated sender identity for realtime agent consults; update OpenClaw before enabling FaceTime",
    );
  }
}

function agentIdFromSessionKey(sessionKey: string, config: OpenClawConfig): string {
  const normalized = sessionKey.trim();
  if (normalized.startsWith("agent:")) {
    return normalized.split(":")[1] || resolveDefaultAgentId(config);
  }
  return resolveDefaultAgentId(config);
}

function buildRealtimeInstructions(params: {
  instructions: string | undefined;
  bootstrapContext: string | undefined;
  toolPolicy: FaceTimeConfig["realtime"]["toolPolicy"];
}): string {
  const callControlInstructions = [
    "Call control:",
    `- When the caller asks you to hang up, end, leave, or disconnect the current FaceTime call, call ${FACETIME_END_CALL_TOOL_NAME} immediately.`,
    `- Never delegate a current-call hangup request to ${REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME}, ask for confirmation, or say that you will check.`,
  ].join("\n");
  const proxyInstructions =
    params.toolPolicy === "none"
      ? undefined
      : [
          "Mode: OpenClaw agent proxy.",
          "You are the realtime voice surface for the same configured OpenClaw agent the owner can message directly.",
          "The FaceTime caller is the authenticated owner/user described by the loaded workspace profile context. Recognize them from that context without asking them to reconfirm.",
          "Do not mention a backend, supervisor, helper, or separate system. Present the result as your own work.",
          `Delegate substantive requests, actions, tool work, current facts, memory, workspace context, identity, persona, and user-specific context with ${REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME}.`,
          "Do not block, refuse, or downscope at the voice layer. Delegate to OpenClaw and treat its result as authoritative.",
          'While waiting for a tool result, use at most one short natural backchannel such as "one sec"; do not repeat progress updates or treat it as the final answer.',
          "Never claim you retried or are retrying unless a new tool result explicitly confirms a new attempt.",
          buildRealtimeVoiceAgentConsultPolicyInstructions({
            toolPolicy: params.toolPolicy,
            consultPolicy: "always",
          }),
        ]
          .filter(Boolean)
          .join("\n");
  return [
    params.instructions?.trim(),
    params.bootstrapContext?.trim(),
    callControlInstructions,
    proxyInstructions,
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function resolveRealtimeProviderConfigs(params: {
  config: FaceTimeConfig;
  fullConfig: OpenClawConfig;
}): Promise<Record<string, Record<string, unknown>>> {
  const providers: Record<string, Record<string, unknown>> = {};
  for (const [providerId, providerConfig] of Object.entries(params.config.realtime.providers)) {
    const next = { ...providerConfig };
    if ("apiKey" in next) {
      const resolved = await resolveConfiguredSecretInputString({
        config: params.fullConfig,
        env: process.env,
        value: next.apiKey,
        path: `plugins.entries.facetime.config.realtime.providers.${providerId}.apiKey`,
      });
      if (resolved.value) {
        next.apiKey = resolved.value;
      }
    }
    providers[providerId] = next;
  }
  return providers;
}

export async function startFaceTimeTalkDriver(params: {
  config: FaceTimeConfig;
  fullConfig: OpenClawConfig;
  runtime: PluginRuntime;
  logger: RuntimeLogger;
  callUUID: string;
  senderId: string;
  senderIsOwner: true;
  captureBinary: string;
  signal?: AbortSignal;
  onHangupRequested: () => Promise<void>;
  onFailure?: (error: Error) => boolean | Promise<boolean>;
}): Promise<FaceTimeTalkDriver> {
  if (params.signal?.aborted) {
    throw new Error("FaceTime talk startup aborted");
  }
  // Fail closed before the call is answered; older hosts silently ignore the
  // owner fields and would otherwise create a privilege-downgrade footgun.
  assertAuthenticatedSenderConsultSupport();
  const consultAgentId = agentIdFromSessionKey(
    params.config.realtime.sessionKey,
    params.fullConfig,
  );
  const normalizedCallUUID = params.callUUID.trim().toLowerCase();
  const consultSessionKey = `agent:${consultAgentId}:facetime:${normalizedCallUUID}`;
  const requesterSessionKey = params.config.realtime.sessionKey.startsWith("agent:")
    ? params.config.realtime.sessionKey
    : `agent:${consultAgentId}:${params.config.realtime.sessionKey}`;
  const talk = createTalkSessionController(
    {
      sessionId: `facetime:${params.callUUID}`,
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
      provider: params.config.realtime.provider,
      turnIdPrefix: `facetime:${params.callUUID}:turn`,
    },
    { onEvent: recordTalkObservabilityEvent },
  );
  const recentTalkEvents: TalkEvent[] = [];
  const transcript: TranscriptEntry[] = [];
  let stopped = false;
  let mediaSuspended = false;
  let bridge: RealtimeVoiceBridgeSession | undefined;
  let pump: FaceTimeAudioPump | undefined;
  let lastInputAudioStatusAt = 0;
  let callMediaTimestampMs = 0;
  let responseStartTimestampMs: number | undefined;
  let responsePlaybackStartMs: number | undefined;
  let responseGenerationDone = false;
  let hangupRequested = false;
  const pendingAgentConsults = new Map<
    string,
    {
      callId: string;
      turnId: string;
      name: string;
      cancelRequested: boolean;
      backendSettled: boolean;
    }
  >();
  let failurePromise: Promise<boolean> | undefined;
  let activated = false;
  let providerReady = false;
  let resolveProviderReady = () => {};
  const providerReadyPromise = new Promise<void>((resolve) => {
    resolveProviderReady = resolve;
  });
  let providerConnectPromise: Promise<void> | undefined;
  let audioReadyPromise: Promise<void> | undefined;
  let interruptProviderConnect: (() => void) | undefined;
  let mediaSuspensionError: Error | undefined;
  let rejectMediaSuspended: ((error: Error) => void) | undefined;
  const mediaSuspendedPromise = new Promise<never>((_resolve, reject) => {
    rejectMediaSuspended = reject;
  });
  void mediaSuspendedPromise.catch(() => {});
  let suspendMediaPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  let startupSettled = false;
  let startupFailure: Error | undefined;
  let rejectStartupFailure: ((error: Error) => void) | undefined;
  const startupFailurePromise = new Promise<never>((_resolve, reject) => {
    rejectStartupFailure = reject;
  });
  // A provider or audio callback can fail while connect() is still pending.
  // Keep that failure observable until startup either rejects or returns a live driver.
  void startupFailurePromise.catch(() => {});

  const signalStartupFailure = (error: Error) => {
    if (startupSettled || startupFailure) {
      return;
    }
    startupFailure = error;
    rejectStartupFailure?.(error);
  };

  const reportFailure = (error: Error): Promise<boolean> => {
    if (failurePromise) {
      return failurePromise;
    }
    failurePromise = Promise.resolve(params.onFailure?.(error)).then((safeToClose) => {
      return safeToClose !== false;
    });
    return failurePromise;
  };

  const suspendMedia = async (reason = "suspended") => {
    if (suspendMediaPromise) {
      return await suspendMediaPromise;
    }
    // Set the terminal media state before touching the provider. Its close
    // callback must not report a second failure or restart any media path.
    mediaSuspended = true;
    activated = false;
    providerReady = false;
    mediaSuspensionError ??= new Error(`FaceTime model media suspended: ${reason}`);
    rejectMediaSuspended?.(mediaSuspensionError);
    interruptProviderConnect?.();
    abortPendingAgentConsultsForClose();
    suspendMediaPromise = (async () => {
      try {
        bridge?.close();
      } catch (error) {
        params.logger.debug?.(
          `[facetime] realtime bridge close ignored: ${formatErrorMessage(error)}`,
        );
      }
      try {
        await pump?.suspendMedia();
      } catch (error) {
        // The logical media gates above are already terminal. Native cleanup
        // failure must not prevent carrier safety reporting or final teardown.
        params.logger.warn?.(
          `[facetime] native media suspension failed: ${formatErrorMessage(error)}`,
        );
      }
      resetResponsePlayback();
      finishOutputAudio(reason);
    })();
    return await suspendMediaPromise;
  };

  const close = async (reason = "closed") => {
    if (closePromise) {
      return await closePromise;
    }
    closePromise = (async () => {
      const mediaStop = suspendMedia(reason);
      stopped = true;
      try {
        await mediaStop;
      } finally {
        try {
          await pump?.stop();
        } finally {
          remember({ type: "session.closed", payload: { reason }, final: true });
        }
      }
    })();
    return await closePromise;
  };

  const remember = (input: TalkEventInput) => pushRecent(recentTalkEvents, talk.emit(input));
  const ensureTurn = () => {
    const turn = talk.ensureTurn({ payload: { callUUID: params.callUUID } });
    pushRecent(recentTalkEvents, turn.event);
    return turn.turnId;
  };
  const finishOutputAudio = (reason: string) => {
    pushRecent(recentTalkEvents, talk.finishOutputAudio({ payload: { reason } }));
  };
  const endTurn = (reason: string) => {
    const ended = talk.endTurn({ payload: { reason } });
    if (ended.ok) {
      pushRecent(recentTalkEvents, ended.event);
    }
  };
  const playedCurrentResponseMs = () =>
    responsePlaybackStartMs === undefined
      ? 0
      : Math.max(0, (pump?.playedAudioMs() ?? 0) - responsePlaybackStartMs);
  const resetResponsePlayback = () => {
    responseStartTimestampMs = undefined;
    responsePlaybackStartMs = undefined;
    responseGenerationDone = false;
  };
  const finishDrainedResponse = () => {
    if (responseStartTimestampMs === undefined) {
      return;
    }
    callMediaTimestampMs = Math.max(
      callMediaTimestampMs,
      responseStartTimestampMs + playedCurrentResponseMs(),
    );
    bridge?.setMediaTimestamp(Math.floor(callMediaTimestampMs));
    resetResponsePlayback();
    finishOutputAudio("playback-drained");
    endTurn("response.done");
  };
  const submitToolError = (event: RealtimeVoiceToolCallEvent, error: string) => {
    const callId = event.callId || event.itemId;
    remember({
      type: "tool.error",
      callId,
      payload: { name: event.name, error },
      final: true,
    });
    bridge?.submitToolResult(callId, { error });
  };
  const abortPendingAgentConsult = async (pending: {
    cancelRequested: boolean;
    backendSettled: boolean;
  }) => {
    const storePath = params.runtime.agent.session.resolveStorePath(
      params.fullConfig.session?.store,
      {
        agentId: consultAgentId,
      },
    );
    // Session creation and run registration are asynchronous. Keep looking
    // until the cancelled backend settles. Unref each retry so a provider that
    // never settles cannot keep gateway shutdown alive.
    let retryDelayMs = 25;
    while (pending.cancelRequested && !pending.backendSettled) {
      try {
        const sessionEntry = params.runtime.agent.session.getSessionEntry({
          storePath,
          sessionKey: consultSessionKey,
          readConsistency: "latest",
        });
        const sessionId = sessionEntry?.sessionId?.trim();
        if (sessionId && abortAgentHarnessRun(sessionId)) {
          return;
        }
      } catch (error) {
        params.logger.debug?.(
          `[facetime] agent consult abort lookup retry: ${formatErrorMessage(error)}`,
        );
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, retryDelayMs);
        timer.unref?.();
      });
      retryDelayMs = Math.min(retryDelayMs * 2, 1_000);
    }
  };
  function abortPendingAgentConsultsForClose() {
    for (const pending of pendingAgentConsults.values()) {
      pending.cancelRequested = true;
      pendingAgentConsults.delete(pending.callId);
      void abortPendingAgentConsult(pending);
    }
  }
  const cancelPendingAgentConsults = () => {
    for (const pending of pendingAgentConsults.values()) {
      if (pending.cancelRequested) {
        continue;
      }
      pending.cancelRequested = true;
      void abortPendingAgentConsult(pending);
      const result = buildRealtimeVoiceAgentCancelProviderResult(
        "The caller continued speaking before this consult completed.",
      );
      void (async () => {
        try {
          if (!bridge) {
            throw new Error("Realtime bridge unavailable during agent consult cancellation");
          }
          const options =
            bridge.bridge.supportsToolResultSuppression === false
              ? undefined
              : { suppressResponse: true };
          await bridge.submitToolResult(pending.callId, result, options);
          if (pendingAgentConsults.get(pending.callId) !== pending) {
            return;
          }
          pendingAgentConsults.delete(pending.callId);
          remember({
            type: "tool.result",
            turnId: pending.turnId,
            callId: pending.callId,
            payload: { name: pending.name, result },
            final: true,
          });
        } catch (error) {
          if (pendingAgentConsults.get(pending.callId) !== pending) {
            return;
          }
          pendingAgentConsults.delete(pending.callId);
          const normalized = error instanceof Error ? error : new Error(String(error));
          remember({
            type: "tool.error",
            turnId: pending.turnId,
            callId: pending.callId,
            payload: { name: pending.name, error: formatErrorMessage(normalized) },
            final: true,
          });
          await suspendMedia("consult-cancel-failed");
          const safeToClose = await reportFailure(normalized);
          if (safeToClose) {
            await close("consult-cancel-failed");
          }
        }
      })();
    }
  };
  const submitHangupToolResult = async (event: RealtimeVoiceToolCallEvent) => {
    const callId = event.callId || event.itemId;
    const turnId = ensureTurn();
    const result = {
      status: "ending",
      message: "The current FaceTime call is ending. Do not speak another response.",
    };
    remember({
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
      remember({
        type: "tool.result",
        turnId,
        callId,
        payload: { name: event.name, result },
        final: true,
      });
    } catch (error) {
      const message = formatErrorMessage(error);
      params.logger.debug?.(`[facetime] hangup tool result ignored: ${message}`);
      remember({
        type: "tool.error",
        turnId,
        callId,
        payload: { name: event.name, error: message },
        final: true,
      });
    }
  };
  const handleToolCall = async (event: RealtimeVoiceToolCallEvent) => {
    if (stopped || mediaSuspended) {
      return;
    }
    const callId = event.callId || event.itemId;
    if (event.name === FACETIME_END_CALL_TOOL_NAME) {
      const shouldRequestHangup = !hangupRequested;
      hangupRequested = true;
      // Complete the provider tool lifecycle before carrier teardown closes the
      // realtime bridge. Duplicate provider events must not hang up twice.
      await submitHangupToolResult(event);
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
      submitToolError(event, `Tool "${event.name}" not available`);
      return;
    }
    const turnId = ensureTurn();
    const pendingConsult = {
      callId,
      turnId,
      name: event.name,
      cancelRequested: false,
      backendSettled: false,
    };
    pendingAgentConsults.set(callId, pendingConsult);
    remember({
      type: "tool.call",
      turnId,
      itemId: event.itemId,
      callId,
      payload: { name: event.name, args: event.args },
    });
    remember({
      type: "tool.progress",
      turnId,
      callId,
      payload: { name: event.name, status: "working" },
    });
    if (bridge?.bridge.supportsToolResultContinuation) {
      bridge.submitToolResult(callId, buildRealtimeVoiceAgentConsultWorkingResponse("caller"), {
        willContinue: true,
      });
    }
    // Keep compatibility with hosts whose declarations predate these additive
    // fields; updated OpenClaw runtimes forward both into runEmbeddedAgent.
    void (
      consultRealtimeVoiceAgent as (params: AuthenticatedOwnerConsultParams) => Promise<{
        text: string;
      }>
    )({
      cfg: params.fullConfig,
      agentRuntime: params.runtime.agent,
      logger: params.logger,
      agentId: consultAgentId,
      sessionKey: consultSessionKey,
      spawnedBy: requesterSessionKey,
      senderId: params.senderId,
      senderIsOwner: params.senderIsOwner,
      contextMode: "fork",
      messageProvider: AGENT_CONSULT_MESSAGE_PROVIDER,
      lane: `facetime:${normalizedCallUUID}`,
      runIdPrefix: `facetime:${normalizedCallUUID}`,
      args: event.args,
      transcript,
      surface: "a private FaceTime call",
      userLabel: "Caller",
      assistantLabel: "Assistant",
      questionSourceLabel: "caller",
      toolsAllow: resolveRealtimeVoiceAgentConsultToolsAllow(params.config.realtime.toolPolicy),
      extraSystemPrompt: CONSULT_SYSTEM_PROMPT,
    })
      .then((result) => {
        pendingConsult.backendSettled = true;
        if (pendingAgentConsults.get(callId) !== pendingConsult || pendingConsult.cancelRequested) {
          return;
        }
        pendingAgentConsults.delete(callId);
        remember({
          type: "tool.result",
          turnId,
          callId,
          payload: { name: event.name, result },
          final: true,
        });
        bridge?.submitToolResult(callId, result);
      })
      .catch((error: Error) => {
        pendingConsult.backendSettled = true;
        if (pendingAgentConsults.get(callId) !== pendingConsult || pendingConsult.cancelRequested) {
          return;
        }
        pendingAgentConsults.delete(callId);
        const message = formatErrorMessage(error);
        params.logger.warn?.(`[facetime] agent consult failed: ${message}`);
        remember({
          type: "tool.error",
          turnId,
          callId,
          payload: { name: event.name, error: message },
          final: true,
        });
        bridge?.submitToolResult(callId, { error: message });
      });
  };

  remember({ type: "session.started", payload: { callUUID: params.callUUID } });
  pump = startFaceTimeAudioPump({
    captureBinary: params.captureBinary,
    logger: params.logger,
    onInputAudio(audio) {
      if (stopped || mediaSuspended || !activated) {
        return;
      }
      callMediaTimestampMs += audio.byteLength / PCM16_MONO_24KHZ_BYTES_PER_MILLISECOND;
      if (!talk.outputAudioActive) {
        bridge?.setMediaTimestamp(Math.floor(callMediaTimestampMs));
      }
      const now = Date.now();
      if (now - lastInputAudioStatusAt >= INPUT_AUDIO_STATUS_INTERVAL_MS) {
        lastInputAudioStatusAt = now;
        remember({
          type: "input.audio.delta",
          turnId: ensureTurn(),
          payload: { byteLength: audio.byteLength },
        });
      }
      bridge?.sendAudio(audio);
    },
    async onError(error) {
      signalStartupFailure(error);
      remember({
        type: "session.error",
        payload: { message: formatErrorMessage(error) },
        final: true,
      });
      await suspendMedia("audio-error");
      const safeToClose = await reportFailure(error);
      if (safeToClose) {
        await close("audio-error");
      }
      return safeToClose;
    },
    onPlaybackDrained() {
      if (responseGenerationDone) {
        finishDrainedResponse();
      }
    },
  });
  try {
    await Promise.race([pump.suppressionReady(), startupFailurePromise]);
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    await suspendMedia("capture-start-failed");
    const safeToClose = startupFailure === normalized ? await reportFailure(normalized) : true;
    if (safeToClose) {
      await close("capture-start-failed");
    }
    throw error;
  }
  const connectProvider = async () => {
    if (providerConnectPromise) {
      return await providerConnectPromise;
    }
    providerConnectPromise = (async () => {
      let removeAbortListener: (() => void) | undefined;
      let readinessTimer: NodeJS.Timeout | undefined;
      const interrupted = new Promise<never>((_resolve, reject) => {
        const interrupt = () => reject(new Error("FaceTime talk startup aborted"));
        interruptProviderConnect = interrupt;
        params.signal?.addEventListener("abort", interrupt, { once: true });
        removeAbortListener = () => params.signal?.removeEventListener("abort", interrupt);
        if (params.signal?.aborted || stopped || mediaSuspended) {
          interrupt();
        }
      });
      const readinessTimedOut = new Promise<never>((_resolve, reject) => {
        readinessTimer = setTimeout(() => {
          reject(new Error("Realtime provider was not ready within 15 seconds"));
        }, REALTIME_READY_TIMEOUT_MS);
        readinessTimer.unref?.();
      });
      const prepareAndConnect = async () => {
        const providerConfigs = await resolveRealtimeProviderConfigs({
          config: params.config,
          fullConfig: params.fullConfig,
        });
        if (params.signal?.aborted || stopped || mediaSuspended) {
          throw new Error("FaceTime talk startup aborted");
        }
        const resolved = resolveConfiguredRealtimeVoiceProvider({
          configuredProviderId: params.config.realtime.provider,
          providerConfigs: {
            ...providerConfigs,
            [params.config.realtime.provider]: {
              ...(providerConfigs[params.config.realtime.provider] ?? {}),
              voice: params.config.realtime.voice,
            },
          },
          cfg: params.fullConfig,
          defaultModel: params.config.realtime.model,
          noRegisteredProviderMessage: "No realtime voice provider registered",
        });
        let bootstrapContext: string | undefined;
        try {
          bootstrapContext = await resolveRealtimeBootstrapContextInstructions({
            config: params.fullConfig,
            agentId: consultAgentId,
            sessionKey: requesterSessionKey,
            warn: (message) =>
              params.logger.warn?.(`[facetime] realtime bootstrap context: ${message}`),
          });
        } catch (error) {
          params.logger.warn?.(
            `[facetime] realtime bootstrap context unavailable: ${formatErrorMessage(error)}`,
          );
        }
        if (params.signal?.aborted || stopped || mediaSuspended) {
          throw new Error("FaceTime talk startup aborted");
        }
        bridge = createRealtimeVoiceBridgeSession({
          provider: resolved.provider,
          providerConfig: resolved.providerConfig,
          audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
          // Configured voice/personality instructions remain customizable, but the
          // authoritative-agent boundary must not disappear when they are replaced.
          instructions: buildRealtimeInstructions({
            instructions: params.config.realtime.instructions,
            bootstrapContext,
            toolPolicy: params.config.realtime.toolPolicy,
          }),
          autoRespondToAudio: true,
          triggerGreetingOnReady: false,
          initialGreetingInstructions: "Greet the caller briefly and say you are listening.",
          markStrategy: "ack-immediately",
          tools: resolveRealtimeVoiceAgentConsultTools(params.config.realtime.toolPolicy, [
            FACETIME_END_CALL_TOOL,
          ]),
          audioSink: {
            isOpen: () => !stopped && !mediaSuspended,
            sendAudio(audio) {
              if (stopped || mediaSuspended) {
                return;
              }
              const turnId = ensureTurn();
              if (!talk.outputAudioActive) {
                responseStartTimestampMs = callMediaTimestampMs;
                responsePlaybackStartMs = pump?.generatedAudioMs() ?? 0;
                responseGenerationDone = false;
                bridge?.setMediaTimestamp(Math.floor(callMediaTimestampMs));
              }
              pushRecent(
                recentTalkEvents,
                talk.startOutputAudio({ turnId, payload: { callUUID: params.callUUID } }).event,
              );
              remember({
                type: "output.audio.delta",
                turnId,
                payload: { byteLength: audio.byteLength },
              });
              pump?.writeOutputAudio(audio);
            },
            clearAudio() {
              if (stopped || mediaSuspended) {
                return;
              }
              pump?.clearOutputAudio();
              resetResponsePlayback();
              finishOutputAudio("clear");
            },
          },
          onTranscript(role, text, final) {
            if (stopped || mediaSuspended) {
              return;
            }
            const turnId = ensureTurn();
            remember({
              type:
                role === "assistant"
                  ? final
                    ? "output.text.done"
                    : "output.text.delta"
                  : final
                    ? "transcript.done"
                    : "transcript.delta",
              turnId,
              payload: role === "assistant" ? { text } : { role, text },
              final,
            });
            if (role === "user" && final) {
              remember({
                type: "input.audio.committed",
                turnId,
                payload: { callUUID: params.callUUID },
                final: true,
              });
            }
            if (final) {
              transcript.push({ role, text });
              if (transcript.length > 40) {
                transcript.splice(0, transcript.length - 40);
              }
            }
          },
          onEvent(event) {
            if (stopped || mediaSuspended) {
              return;
            }
            if (!(event.direction === "client" && event.type === "input_audio_buffer.append")) {
              remember({
                type: "health.changed",
                payload: {
                  name: `${event.direction}:${event.type}`,
                  message: event.detail,
                },
              });
            }
            if (event.type === "input_audio_buffer.speech_started") {
              // A caller follow-up supersedes any consult started for the previous
              // utterance. Close its provider tool call immediately so a slow agent
              // cannot block the new turn, then ignore its eventual settlement.
              cancelPendingAgentConsults();
              const playbackActive =
                responseStartTimestampMs !== undefined && (pump?.queuedAudioMs() ?? 0) > 0;
              if (responseStartTimestampMs !== undefined) {
                bridge?.setMediaTimestamp(
                  resolvePlaybackMediaTimestamp({
                    responseStartTimestampMs,
                    playedAudioMs: playedCurrentResponseMs(),
                  }),
                );
              }
              bridge?.handleBargeIn({ audioPlaybackActive: playbackActive });
              if (playbackActive || talk.outputAudioActive) {
                pump?.clearOutputAudio();
                finishOutputAudio("barge-in");
              }
              resetResponsePlayback();
            } else if (event.type === "response.done") {
              responseGenerationDone = true;
              if (responseStartTimestampMs === undefined) {
                finishOutputAudio("response.done");
                endTurn("response.done");
              } else if ((pump?.queuedAudioMs() ?? 0) === 0) {
                finishDrainedResponse();
              }
            } else if (event.type === "error") {
              remember({
                type: "session.error",
                payload: { message: event.detail ?? "Realtime provider error" },
                final: true,
              });
            }
          },
          onToolCall: handleToolCall,
          onReady() {
            if (!stopped && !mediaSuspended) {
              remember({ type: "session.ready", payload: { callUUID: params.callUUID } });
              resolveProviderReady();
            }
          },
          onError(error) {
            if (stopped || mediaSuspended) {
              return;
            }
            signalStartupFailure(error);
            remember({
              type: "session.error",
              payload: { message: formatErrorMessage(error) },
              final: true,
            });
            params.logger.warn(`[facetime] realtime bridge failed: ${formatErrorMessage(error)}`);
            void (async () => {
              await suspendMedia("error");
              const safeToClose = await reportFailure(error);
              if (safeToClose) {
                await close("error");
              }
            })();
          },
          onClose(reason) {
            if (stopped || mediaSuspended) {
              return;
            }
            finishOutputAudio(reason);
            remember({ type: "session.closed", payload: { reason }, final: true });
            const error = new Error(`Realtime bridge closed unexpectedly: ${reason}`);
            signalStartupFailure(error);
            void (async () => {
              await suspendMedia("provider-closed");
              const safeToClose = await reportFailure(error);
              if (safeToClose) {
                await close("provider-closed");
              }
            })();
          },
        });
        await bridge.connect();
      };
      try {
        // Provider connect() may return before the server's setup-complete
        // event. onReady is the contract that the session can accept audio.
        await Promise.race([
          Promise.all([prepareAndConnect(), providerReadyPromise]),
          startupFailurePromise,
          interrupted,
          readinessTimedOut,
        ]);
        if (startupFailure) {
          throw startupFailure;
        }
        if (params.signal?.aborted || stopped || mediaSuspended) {
          throw new Error("FaceTime talk startup aborted");
        }
        startupSettled = true;
        providerReady = true;
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        await suspendMedia(
          params.signal?.aborted || stopped ? "startup-aborted" : "connect-failed",
        );
        const safeToClose =
          params.signal?.aborted || stopped ? true : await reportFailure(normalized);
        if (safeToClose) {
          await close(params.signal?.aborted || stopped ? "startup-aborted" : "connect-failed");
        }
        throw normalized;
      } finally {
        if (readinessTimer) {
          clearTimeout(readinessTimer);
        }
        interruptProviderConnect = undefined;
        removeAbortListener?.();
      }
    })();
    return await providerConnectPromise;
  };
  return {
    callUUID: params.callUUID,
    get recentTalkEvents() {
      return recentTalkEvents;
    },
    async readyForAudio() {
      audioReadyPromise ??= connectProvider().then(async () => {
        await Promise.race([pump?.routeReady(), mediaSuspendedPromise]);
        // A route-ready callback can race with safety suspension. Never let an
        // already-waiting runtime resume carrier transmission afterward.
        if (mediaSuspended || stopped) {
          throw mediaSuspensionError ?? new Error("FaceTime model media is unavailable");
        }
      });
      await audioReadyPromise;
    },
    processOutputSuppressed() {
      return pump?.processOutputSuppressed() ?? false;
    },
    realtimeActive() {
      return providerReady && !mediaSuspended && !stopped;
    },
    activate() {
      if (stopped || mediaSuspended || !providerReady || activated) {
        return;
      }
      activated = true;
      bridge?.triggerGreeting("Greet the caller briefly and say you are listening.");
    },
    suspendMedia,
    close,
  };
}
