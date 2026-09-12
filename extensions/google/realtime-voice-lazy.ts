import { createLazyRuntimeSurface } from "openclaw/plugin-sdk/lazy-runtime";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceProviderConfig,
  RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice";
import { createRealtimeVoiceAudioQueue } from "openclaw/plugin-sdk/realtime-voice-audio-queue";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

const loadGoogleRealtimeVoiceProvider = createLazyRuntimeSurface(
  () => import("./realtime-voice-provider.js"),
  (mod) => mod.buildGoogleRealtimeVoiceProvider(),
);

function resolveGoogleRealtimeProviderConfig(
  rawConfig: RealtimeVoiceProviderConfig,
  cfg?: { models?: { providers?: { google?: { apiKey?: unknown } } } },
): RealtimeVoiceProviderConfig {
  const providers = asOptionalRecord(rawConfig.providers);
  const raw =
    asOptionalRecord(providers?.google) ?? asOptionalRecord(rawConfig.google) ?? rawConfig;
  return {
    ...raw,
    ...(raw.apiKey === undefined
      ? cfg?.models?.providers?.google?.apiKey === undefined
        ? {}
        : {
            apiKey: normalizeResolvedSecretInputString({
              value: cfg.models.providers.google.apiKey,
              path: "models.providers.google.apiKey",
            }),
          }
      : {
          apiKey: normalizeResolvedSecretInputString({
            value: raw.apiKey,
            path: "plugins.entries.voice-call.config.realtime.providers.google.apiKey",
          }),
        }),
  };
}

function resolveGoogleRealtimeEnvApiKey(): string | undefined {
  return (
    normalizeOptionalString(process.env.GEMINI_API_KEY) ??
    normalizeOptionalString(process.env.GOOGLE_API_KEY)
  );
}

const GOOGLE_REALTIME_LAZY_MAX_PENDING_USER_MESSAGES = 128;
const GOOGLE_REALTIME_LAZY_MAX_PENDING_USER_MESSAGE_BYTES = 256 * 1024;

function createLazyGoogleRealtimeVoiceBridge(
  req: RealtimeVoiceBridgeCreateRequest,
): RealtimeVoiceBridge {
  const getPlaybackState = req.getPlaybackState;
  const handleDelegationInput = req.handleDelegationInput;
  const runAgentConsult = req.runAgentConsult;
  let bridge: RealtimeVoiceBridge | undefined;
  let bridgePromise: Promise<RealtimeVoiceBridge> | undefined;
  let bridgePromiseGeneration = 0;
  let bridgeReady = false;
  let closePromise: Promise<void> | undefined;
  type CloseOwner = { generation: number; outcome: "completed" | "error" };
  let closeOwner: CloseOwner | undefined;
  let terminalNotified = false;
  // Provider close is terminal for input admission. Only an explicit connect()
  // call may reopen it; late callbacks and microphone frames stay ignored.
  let terminated = false;
  let generation = 0;
  let latestMediaTimestamp: number | undefined;
  let pendingGreeting: string | undefined;
  // Lazy startup keeps the newest microphone tail when loading stalls.
  const pendingAudio = createRealtimeVoiceAudioQueue("drop-oldest");
  const pendingUserMessages: string[] = [];
  let pendingUserMessageBytes = 0;
  const closedBridges = new WeakMap<RealtimeVoiceBridge, void | Promise<void>>();
  const clearPendingInput = () => {
    pendingAudio.clear();
    pendingUserMessages.length = 0;
    pendingUserMessageBytes = 0;
    pendingGreeting = undefined;
    latestMediaTimestamp = undefined;
  };
  const isCurrentNonterminalGeneration = (candidate: number) =>
    candidate === generation && !terminated;
  const guardProviderCallback =
    <TArgs extends unknown[]>(callbackGeneration: number, callback: (...args: TArgs) => void) =>
    (...args: TArgs) => {
      if (isCurrentNonterminalGeneration(callbackGeneration)) {
        callback(...args);
      }
    };
  // Loading and connecting finish on separate async boundaries. Keep close ownership
  // here so either late completion closes the provider bridge exactly once.
  const closeBridge = (loadedBridge = bridge): void | Promise<void> => {
    if (!loadedBridge) {
      return;
    }
    if (closedBridges.has(loadedBridge)) {
      return closedBridges.get(loadedBridge);
    }
    closedBridges.set(loadedBridge, undefined);
    const pending = loadedBridge.close();
    closedBridges.set(loadedBridge, pending);
    return pending;
  };
  const emitTerminal = (terminalGeneration: number, reason: "completed" | "error") => {
    if (terminalGeneration !== generation || terminalNotified) {
      return;
    }
    if (closeOwner?.generation === terminalGeneration) {
      if (reason === "error") {
        closeOwner.outcome = reason;
      }
      return;
    }
    terminalNotified = true;
    bridgeReady = false;
    terminated = true;
    clearPendingInput();
    req.onClose?.(reason);
  };
  const closeCurrentBridge = (
    outcome: "completed" | "error",
    primaryError?: unknown,
  ): void | Promise<void> => {
    if (terminated) {
      return closePromise;
    }
    const loadedBridge = bridge;
    const loading = bridgePromise;
    terminated = true;
    bridgeReady = false;
    clearPendingInput();
    const owner: CloseOwner = { generation, outcome };
    closeOwner = owner;
    const finishClose = (reason = owner.outcome) => {
      if (closeOwner === owner) {
        closeOwner = undefined;
        if (outcome === "error") {
          try {
            req.onError?.(
              primaryError instanceof Error ? primaryError : new Error(String(primaryError)),
            );
          } catch {
            // Error observers cannot replace the disposal outcome or skip its terminal notification.
          }
        }
      }
      emitTerminal(owner.generation, reason);
    };
    const failClose = (error: unknown): never => {
      try {
        finishClose("error");
      } catch {
        // Consumer callback failure must not replace the provider disposal error.
      }
      throw error;
    };
    let pending: void | Promise<void>;
    try {
      pending = loadedBridge
        ? closeBridge(loadedBridge)
        : loading?.then((loaded) => closeBridge(loaded));
    } catch (error) {
      return failClose(error);
    }
    if (pending) {
      const completion = pending.then(() => finishClose(), failClose);
      if (closeOwner === owner) {
        closePromise = completion;
      }
      return completion;
    }
    finishClose();
  };
  const throwTerminalBridgeError = async (
    terminalGeneration: number,
    loadedBridge: RealtimeVoiceBridge,
    primaryError: unknown,
  ): Promise<never> => {
    try {
      if (isCurrentNonterminalGeneration(terminalGeneration)) {
        await closeCurrentBridge("error", primaryError);
      } else {
        await closeBridge(loadedBridge);
      }
    } catch {
      // Disposal and observer failures cannot replace the original connect error.
    }
    throw primaryError;
  };
  const loadBridge = async () => {
    if (!bridgePromise) {
      const loadGeneration = generation;
      bridgePromiseGeneration = loadGeneration;
      bridgePromise = loadGoogleRealtimeVoiceProvider().then((provider) =>
        provider.createBridge({
          ...req,
          onAudio: guardProviderCallback(loadGeneration, req.onAudio),
          onClearAudio: guardProviderCallback(loadGeneration, req.onClearAudio),
          ...(getPlaybackState
            ? {
                getPlaybackState: () => {
                  if (!isCurrentNonterminalGeneration(loadGeneration)) {
                    return [];
                  }
                  const playback = getPlaybackState();
                  return isCurrentNonterminalGeneration(loadGeneration) ? playback : [];
                },
              }
            : {}),
          ...(req.onMark ? { onMark: guardProviderCallback(loadGeneration, req.onMark) } : {}),
          ...(req.onEvent ? { onEvent: guardProviderCallback(loadGeneration, req.onEvent) } : {}),
          ...(req.onResponseDone
            ? { onResponseDone: guardProviderCallback(loadGeneration, req.onResponseDone) }
            : {}),
          ...(req.onToolCall
            ? { onToolCall: guardProviderCallback(loadGeneration, req.onToolCall) }
            : {}),
          ...(req.onError ? { onError: guardProviderCallback(loadGeneration, req.onError) } : {}),
          ...(handleDelegationInput
            ? {
                handleDelegationInput: (text, respond) => {
                  if (!isCurrentNonterminalGeneration(loadGeneration)) {
                    return "control";
                  }
                  return handleDelegationInput(text, (message) => {
                    if (isCurrentNonterminalGeneration(loadGeneration)) {
                      respond(message);
                    }
                  });
                },
              }
            : {}),
          ...(runAgentConsult
            ? {
                runAgentConsult: (params) => {
                  if (!isCurrentNonterminalGeneration(loadGeneration)) {
                    return Promise.reject(new Error("Google realtime voice session closed"));
                  }
                  return runAgentConsult(params);
                },
              }
            : {}),
          ...(req.onTranscript
            ? {
                onTranscript: (role, text, isFinal) => {
                  if (
                    loadGeneration === generation &&
                    (!terminated || (isFinal && closeOwner?.generation === loadGeneration))
                  ) {
                    req.onTranscript?.(role, text, isFinal);
                  }
                },
              }
            : {}),
          onReady: () => {
            if (loadGeneration !== generation || terminated) {
              return;
            }
            req.onReady?.();
            if (loadGeneration !== generation || terminated || !bridge) {
              return;
            }
            bridgeReady = true;
            // `connect()` and provider readiness are separate lifecycle facts.
            // Release prompts only after the provider can accept user content.
            flushPending(bridge);
          },
          onClose: (reason) => {
            emitTerminal(loadGeneration, reason);
          },
        }),
      );
    }
    const loading = bridgePromise;
    const loadGeneration = bridgePromiseGeneration;
    const loadedBridge = await loading;
    // Explicit reconnect can replace the lazy load before it settles. Only the
    // matching generation may publish a bridge; stale instances must close.
    if (loading !== bridgePromise || loadGeneration !== generation || terminated) {
      await closeBridge(loadedBridge);
      return loadedBridge;
    }
    bridge = loadedBridge;
    return loadedBridge;
  };
  const requireBridge = () => {
    if (!bridge) {
      throw new Error("Google realtime voice bridge is not connected");
    }
    return bridge;
  };
  const flushPending = (loadedBridge: RealtimeVoiceBridge) => {
    if (terminated) {
      return;
    }
    if (typeof latestMediaTimestamp === "number") {
      loadedBridge.setMediaTimestamp(latestMediaTimestamp);
    }
    for (const audio of pendingAudio.drain()) {
      loadedBridge.sendAudio(audio);
    }
    const userMessages = pendingUserMessages.splice(0);
    pendingUserMessageBytes = 0;
    for (const text of userMessages) {
      loadedBridge.sendUserMessage?.(text);
    }
    if (pendingGreeting !== undefined) {
      const greeting = pendingGreeting;
      pendingGreeting = undefined;
      loadedBridge.triggerGreeting?.(greeting);
    }
  };
  return {
    get supportsToolResultContinuation() {
      return bridge?.supportsToolResultContinuation ?? false;
    },
    supportsToolResultSuppression: false,
    connect: async () => {
      if (terminated) {
        generation += 1;
        bridge = undefined;
        bridgePromise = undefined;
        bridgeReady = false;
        terminated = false;
        closePromise = undefined;
        closeOwner = undefined;
        terminalNotified = false;
      }
      const connectGeneration = generation;
      const loadedBridge = await loadBridge();
      if (connectGeneration !== generation || terminated) {
        await closeBridge(loadedBridge);
        return;
      }
      try {
        await loadedBridge.connect();
      } catch (error) {
        await throwTerminalBridgeError(connectGeneration, loadedBridge, error);
      }
      if (connectGeneration !== generation || terminated) {
        await closeBridge(loadedBridge);
      }
    },
    sendAudio: (audio) => {
      if (terminated) {
        return;
      }
      if (bridgeReady && bridge) {
        bridge.sendAudio(audio);
        return;
      }
      pendingAudio.enqueue(audio);
    },
    setMediaTimestamp: (ts) => {
      if (terminated) {
        return;
      }
      latestMediaTimestamp = ts;
      bridge?.setMediaTimestamp(ts);
    },
    sendUserMessage: (text) => {
      if (terminated) {
        return;
      }
      if (bridgeReady && bridge) {
        bridge.sendUserMessage?.(text);
        return;
      }
      const messageBytes = Buffer.byteLength(text, "utf8");
      if (
        pendingUserMessages.length >= GOOGLE_REALTIME_LAZY_MAX_PENDING_USER_MESSAGES ||
        pendingUserMessageBytes + messageBytes > GOOGLE_REALTIME_LAZY_MAX_PENDING_USER_MESSAGE_BYTES
      ) {
        req.onError?.(
          new Error("Google realtime voice pending user message queue overflow during startup"),
        );
        return;
      }
      pendingUserMessages.push(text);
      pendingUserMessageBytes += messageBytes;
    },
    triggerGreeting: (instructions) => {
      if (terminated) {
        return;
      }
      if (bridgeReady && bridge) {
        bridge.triggerGreeting?.(instructions);
        return;
      }
      pendingGreeting = instructions;
    },
    handleBargeIn: (options) => {
      if (!terminated) {
        requireBridge().handleBargeIn?.(options);
      }
    },
    submitToolResult: (callId, result, options) => {
      if (terminated) {
        return undefined;
      }
      return requireBridge().submitToolResult(callId, result, options);
    },
    acknowledgeMark: () => {
      if (!terminated) {
        requireBridge().acknowledgeMark();
      }
    },
    close: () => closeCurrentBridge("completed"),
    isConnected: () => !terminated && (bridge?.isConnected() ?? false),
  };
}

export function createLazyGoogleRealtimeVoiceProvider(): RealtimeVoiceProviderPlugin {
  return {
    id: "google",
    label: "Google Live Voice",
    autoSelectOrder: 20,
    resolveConfig: ({ cfg, rawConfig }) => resolveGoogleRealtimeProviderConfig(rawConfig, cfg),
    isConfigured: ({ cfg, providerConfig }) =>
      Boolean(
        normalizeOptionalString(providerConfig.apiKey) ??
        normalizeOptionalString(cfg?.models?.providers?.google?.apiKey) ??
        resolveGoogleRealtimeEnvApiKey(),
      ),
    createBridge: createLazyGoogleRealtimeVoiceBridge,
    createBrowserSession: async (req) => {
      const provider = await loadGoogleRealtimeVoiceProvider();
      if (!provider.createBrowserSession) {
        throw new Error("Google realtime voice browser sessions are unavailable");
      }
      return await provider.createBrowserSession(req);
    },
  };
}
