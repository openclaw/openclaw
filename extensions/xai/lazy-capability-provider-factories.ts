import type { ImageGenerationProvider } from "openclaw/plugin-sdk/image-generation";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { MediaUnderstandingProvider } from "openclaw/plugin-sdk/media-understanding";
import type { PluginCapabilityCatalogHostContext } from "openclaw/plugin-sdk/plugin-entry";
import type {
  RealtimeTranscriptionProviderPlugin,
  RealtimeTranscriptionSession,
  RealtimeTranscriptionSessionCreateRequest,
} from "openclaw/plugin-sdk/realtime-transcription";
import type { RealtimeVoiceProviderPlugin } from "openclaw/plugin-sdk/realtime-voice-provider";
import type { SpeechProviderPlugin } from "openclaw/plugin-sdk/speech";
import type { VideoGenerationProvider } from "openclaw/plugin-sdk/video-generation";
import {
  createXaiImageGenerationProviderMetadata,
  createXaiMediaUnderstandingProviderMetadata,
  createXaiRealtimeTranscriptionProviderMetadata,
  createXaiRealtimeVoiceProviderMetadata,
  createXaiVideoGenerationProviderMetadata,
  normalizeXaiRealtimeTranscriptionProviderConfig,
} from "./capability-provider-metadata-factory.js";
import { createLazyXaiRealtimeVoiceBridge } from "./realtime-voice-lazy.js";
import { createXaiSpeechProviderMetadata } from "./speech-provider-metadata-factory.js";

const MAX_LAZY_REALTIME_TRANSCRIPTION_AUDIO_BYTES = 2 * 1024 * 1024;

const loadXaiImageGenerationProvider = createLazyRuntimeModule(async () =>
  (await import("./image-generation-provider.js")).buildXaiImageGenerationProvider(),
);
const loadXaiMediaUnderstandingProvider = createLazyRuntimeModule(async () =>
  (await import("./stt.js")).buildXaiMediaUnderstandingProvider(),
);
const loadXaiSpeechProvider = createLazyRuntimeModule(async () =>
  (await import("./speech-provider.js")).buildXaiSpeechProvider(),
);
const loadXaiVideoGenerationProvider = createLazyRuntimeModule(async () =>
  (await import("./video-generation-provider.js")).buildXaiVideoGenerationProvider(),
);

function createPendingTranscriptionAudioQueue(): {
  clear: () => void;
  drain: () => Buffer[];
  enqueue: (audio: Buffer) => void;
} {
  let chunks: Buffer[] = [];
  let bytes = 0;
  const clear = () => {
    chunks = [];
    bytes = 0;
  };
  return {
    clear,
    drain: () => {
      const pending = chunks;
      clear();
      return pending;
    },
    enqueue: (audio) => {
      if (audio.byteLength > MAX_LAZY_REALTIME_TRANSCRIPTION_AUDIO_BYTES) {
        return;
      }
      const chunk = Buffer.from(audio);
      chunks.push(chunk);
      bytes += chunk.byteLength;
      while (bytes > MAX_LAZY_REALTIME_TRANSCRIPTION_AUDIO_BYTES) {
        const dropped = chunks.shift();
        bytes -= dropped?.byteLength ?? 0;
      }
    },
  };
}

function createLazyXaiRealtimeTranscriptionSession(
  req: RealtimeTranscriptionSessionCreateRequest,
  loadXaiRealtimeTranscriptionProvider: () => Promise<RealtimeTranscriptionProviderPlugin>,
): RealtimeTranscriptionSession {
  let session: RealtimeTranscriptionSession | undefined;
  let sessionPromise: Promise<RealtimeTranscriptionSession> | undefined;
  let activeConnect: Promise<void> | undefined;
  let closed = false;
  let acceptsInput = false;
  const pendingAudio = createPendingTranscriptionAudioQueue();

  const loadSession = async () => {
    if (!sessionPromise) {
      sessionPromise = loadXaiRealtimeTranscriptionProvider().then((provider) =>
        provider.createSession(req),
      );
    }
    session = await sessionPromise;
    return session;
  };
  return {
    connect: async () => {
      closed = false;
      if (activeConnect) {
        await activeConnect;
        return;
      }
      const promise = (async () => {
        const loadedSession = await loadSession();
        if (closed) {
          loadedSession.close();
          return;
        }
        // connect() synchronously reopens a closed provider session. Starting it
        // first keeps explicit-reconnect audio from being silently discarded.
        const providerConnect = loadedSession.connect();
        for (const audio of pendingAudio.drain()) {
          loadedSession.sendAudio(audio);
        }
        acceptsInput = true;
        await providerConnect;
      })();
      activeConnect = promise;
      try {
        await promise;
      } finally {
        if (activeConnect === promise) {
          activeConnect = undefined;
        }
      }
    },
    sendAudio: (audio) => {
      if (closed) {
        return;
      }
      if (acceptsInput && session) {
        session.sendAudio(audio);
        return;
      }
      pendingAudio.enqueue(audio);
    },
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      acceptsInput = false;
      activeConnect = undefined;
      pendingAudio.clear();
      session?.close();
    },
    isConnected: () => !closed && (session?.isConnected() ?? false),
  };
}

export function createLazyXaiImageGenerationProvider(): ImageGenerationProvider {
  return {
    ...createXaiImageGenerationProviderMetadata(),
    generateImage: async (req) => (await loadXaiImageGenerationProvider()).generateImage(req),
  };
}

export function createLazyXaiMediaUnderstandingProvider(): MediaUnderstandingProvider {
  return {
    ...createXaiMediaUnderstandingProviderMetadata(),
    transcribeAudio: async (req) =>
      (await loadXaiMediaUnderstandingProvider()).transcribeAudio(req),
  };
}

export function createLazyXaiVideoGenerationProvider(
  context: Pick<PluginCapabilityCatalogHostContext, "isProviderApiKeyConfiguredAsync">,
): VideoGenerationProvider {
  return {
    ...createXaiVideoGenerationProviderMetadata(context),
    generateVideo: async (req) => (await loadXaiVideoGenerationProvider()).generateVideo(req),
  };
}

export function createLazyXaiSpeechProvider(
  context: Pick<
    PluginCapabilityCatalogHostContext,
    "isProviderAuthProfileConfigured" | "isProviderAuthProfileConfiguredAsync"
  >,
): SpeechProviderPlugin {
  return {
    ...createXaiSpeechProviderMetadata(context),
    listVoices: async (req) => (await loadXaiSpeechProvider()).listVoices(req),
    synthesize: async (req) => await (await loadXaiSpeechProvider()).synthesize(req),
    streamSynthesize: async (req) => (await loadXaiSpeechProvider()).streamSynthesize(req),
    synthesizeTelephony: async (req) => (await loadXaiSpeechProvider()).synthesizeTelephony(req),
  };
}

export function createLazyXaiRealtimeTranscriptionProvider(
  context: Pick<
    PluginCapabilityCatalogHostContext,
    | "isProviderAuthProfileConfigured"
    | "isProviderAuthProfileConfiguredAsync"
    | "resolveApiKeyForProvider"
    | "createRealtimeTranscriptionWebSocketSession"
  >,
): RealtimeTranscriptionProviderPlugin {
  const loadProvider = createLazyRuntimeModule(async () =>
    (
      await import("./realtime-transcription-provider-factory.js")
    ).buildXaiRealtimeTranscriptionProvider(context),
  );
  return {
    ...createXaiRealtimeTranscriptionProviderMetadata(context),
    createSession: (req) => {
      // Preserve synchronous config validation even though transport code loads on connect().
      normalizeXaiRealtimeTranscriptionProviderConfig(req.providerConfig);
      return createLazyXaiRealtimeTranscriptionSession(req, loadProvider);
    },
  };
}

export function createLazyXaiRealtimeVoiceProvider(
  context: Pick<
    PluginCapabilityCatalogHostContext,
    "isProviderAuthProfileConfigured" | "isProviderAuthProfileConfiguredAsync" | "resolveAgentDir"
  >,
): RealtimeVoiceProviderPlugin {
  return {
    ...createXaiRealtimeVoiceProviderMetadata(context),
    createBridge: createLazyXaiRealtimeVoiceBridge,
  };
}
