import { createLazyRuntimeSurface } from "openclaw/plugin-sdk/lazy-runtime";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceProviderConfig,
  RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice";
import { createRealtimeVoiceAudioQueue } from "openclaw/plugin-sdk/realtime-voice-audio-queue";
import { createLazyRealtimeVoiceBridgeLifecycle } from "openclaw/plugin-sdk/realtime-voice-provider";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveGoogleEnvApiKey } from "./gemini-auth.js";
import { GOOGLE_REALTIME_VOICE_METADATA } from "./realtime-voice-metadata.js";

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

const GOOGLE_REALTIME_LAZY_MAX_PENDING_USER_MESSAGES = 128;
const GOOGLE_REALTIME_LAZY_MAX_PENDING_USER_MESSAGE_BYTES = 256 * 1024;

function createLazyGoogleRealtimeVoiceBridge(
  req: RealtimeVoiceBridgeCreateRequest,
): RealtimeVoiceBridge {
  let bridgeReady = false;
  let latestMediaTimestamp: number | undefined;
  let pendingGreeting: string | undefined;
  // Lazy startup keeps the newest microphone tail when loading stalls.
  const pendingAudio = createRealtimeVoiceAudioQueue("drop-oldest");
  const pendingUserMessages: string[] = [];
  let pendingUserMessageBytes = 0;
  const lifecycle = createLazyRealtimeVoiceBridgeLifecycle({
    label: "Google",
    request: req,
    load: async (request) => (await loadGoogleRealtimeVoiceProvider()).createBridge(request),
    clearPending: () => {
      bridgeReady = false;
      pendingAudio.clear();
      pendingUserMessages.length = 0;
      pendingUserMessageBytes = 0;
      pendingGreeting = undefined;
      latestMediaTimestamp = undefined;
    },
    onProviderReady: (bridge) => {
      if (bridge) {
        bridgeReady = true;
        flushPending(bridge);
      }
    },
  });
  const requireBridge = () => {
    const bridge = lifecycle.bridge;
    if (!bridge) {
      throw new Error("Google realtime voice bridge is not connected");
    }
    return bridge;
  };
  const flushPending = (loadedBridge: RealtimeVoiceBridge) => {
    if (!lifecycle.isActive()) {
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
      return lifecycle.bridge?.supportsToolResultContinuation ?? false;
    },
    supportsToolResultSuppression: false,
    connect: lifecycle.connect,
    sendAudio: (audio) => {
      if (!lifecycle.isActive()) {
        return;
      }
      const bridge = lifecycle.bridge;
      if (bridgeReady && bridge) {
        bridge.sendAudio(audio);
        return;
      }
      pendingAudio.enqueue(audio);
    },
    setMediaTimestamp: (ts) => {
      if (!lifecycle.isActive()) {
        return;
      }
      latestMediaTimestamp = ts;
      lifecycle.bridge?.setMediaTimestamp(ts);
    },
    sendUserMessage: (text) => {
      if (!lifecycle.isActive()) {
        return;
      }
      const bridge = lifecycle.bridge;
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
      if (!lifecycle.isActive()) {
        return;
      }
      const bridge = lifecycle.bridge;
      if (bridgeReady && bridge) {
        bridge.triggerGreeting?.(instructions);
        return;
      }
      pendingGreeting = instructions;
    },
    handleBargeIn: (options) => {
      if (lifecycle.isActive()) {
        requireBridge().handleBargeIn?.(options);
      }
    },
    submitToolResult: (callId, result, options) => {
      if (!lifecycle.isActive()) {
        return undefined;
      }
      return requireBridge().submitToolResult(callId, result, options);
    },
    acknowledgeMark: () => {
      if (lifecycle.isActive()) {
        requireBridge().acknowledgeMark();
      }
    },
    close: lifecycle.close,
    isConnected: () => lifecycle.isActive() && (lifecycle.bridge?.isConnected() ?? false),
  };
}

export function createLazyGoogleRealtimeVoiceProvider(): RealtimeVoiceProviderPlugin {
  return {
    ...GOOGLE_REALTIME_VOICE_METADATA,
    resolveConfig: ({ cfg, rawConfig }) => resolveGoogleRealtimeProviderConfig(rawConfig, cfg),
    isConfigured: ({ cfg, providerConfig }) =>
      Boolean(
        normalizeOptionalString(providerConfig.apiKey) ??
        normalizeOptionalString(cfg?.models?.providers?.google?.apiKey) ??
        resolveGoogleEnvApiKey(),
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
