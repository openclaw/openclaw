import type { ImageGenerationProvider } from "openclaw/plugin-sdk/image-generation";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { MediaUnderstandingProvider } from "openclaw/plugin-sdk/media-understanding";
import type { PluginCapabilityCatalogContext } from "openclaw/plugin-sdk/plugin-entry";
import type {
  RealtimeTranscriptionProviderPlugin,
  RealtimeTranscriptionSession,
  RealtimeTranscriptionSessionCreateRequest,
} from "openclaw/plugin-sdk/realtime-transcription";
import type { RealtimeVoiceProviderPlugin } from "openclaw/plugin-sdk/realtime-voice-provider";
import type {
  SpeechProviderPlugin,
  SpeechSynthesisStreamRequest,
  SpeechTelephonySynthesisRequest,
} from "openclaw/plugin-sdk/speech";
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
  let chunks: Array<Buffer | undefined> = [];
  let head = 0;
  let bytes = 0;
  const clear = () => {
    chunks = [];
    head = 0;
    bytes = 0;
  };
  return {
    clear,
    drain: () => {
      const pending = chunks.slice(head).filter((chunk): chunk is Buffer => chunk !== undefined);
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
      while (bytes > MAX_LAZY_REALTIME_TRANSCRIPTION_AUDIO_BYTES && head < chunks.length) {
        const dropped = chunks[head];
        chunks[head] = undefined;
        head += 1;
        bytes -= dropped?.byteLength ?? 0;
      }
      if (head > 256 && head * 2 >= chunks.length) {
        chunks = chunks.slice(head);
        head = 0;
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
  let activeConnect:
    | {
        generation: number;
        promise: Promise<void>;
      }
    | undefined;
  let generation = 0;
  let closedSessionGeneration: number | undefined;
  let closed = false;
  let acceptsInput = false;
  const pendingAudio = createPendingTranscriptionAudioQueue();

  const closeSession = (
    closeGeneration: number,
    loadedSession: RealtimeTranscriptionSession | undefined = session,
  ) => {
    if (!loadedSession || closedSessionGeneration === closeGeneration) {
      return;
    }
    closedSessionGeneration = closeGeneration;
    loadedSession.close();
  };
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
      if (closed) {
        generation += 1;
        closed = false;
      }
      const connectGeneration = generation;
      if (activeConnect?.generation === connectGeneration) {
        await activeConnect.promise;
        return;
      }
      const promise = (async () => {
        const loadedSession = await loadSession();
        if (connectGeneration !== generation || closed) {
          if (connectGeneration === generation && closed) {
            closeSession(connectGeneration, loadedSession);
          }
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
        if (connectGeneration === generation && closed) {
          closeSession(connectGeneration, loadedSession);
        }
      })();
      const connectTask = { generation: connectGeneration, promise };
      activeConnect = connectTask;
      try {
        await promise;
      } finally {
        if (activeConnect === connectTask) {
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
      pendingAudio.clear();
      closeSession(generation);
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
    transcribeAudio: async (req) => {
      const provider = await loadXaiMediaUnderstandingProvider();
      if (!provider.transcribeAudio) {
        throw new Error("xAI media understanding provider missing transcribeAudio");
      }
      return await provider.transcribeAudio(req);
    },
  };
}

export function createLazyXaiVideoGenerationProvider(
  context: Pick<PluginCapabilityCatalogContext, "isProviderApiKeyConfigured">,
): VideoGenerationProvider {
  return {
    ...createXaiVideoGenerationProviderMetadata(context),
    generateVideo: async (req) => (await loadXaiVideoGenerationProvider()).generateVideo(req),
  };
}

export function createLazyXaiSpeechProvider(
  context: Pick<PluginCapabilityCatalogContext, "isProviderAuthProfileConfigured">,
): SpeechProviderPlugin {
  return {
    ...createXaiSpeechProviderMetadata(context),
    listVoices: async (req) => {
      const provider = await loadXaiSpeechProvider();
      if (!provider.listVoices) {
        throw new Error("xAI speech provider missing listVoices");
      }
      return await provider.listVoices(req);
    },
    synthesize: async (req) => await (await loadXaiSpeechProvider()).synthesize(req),
    streamSynthesize: async (req: SpeechSynthesisStreamRequest) => {
      const provider = await loadXaiSpeechProvider();
      if (!provider.streamSynthesize) {
        throw new Error("xAI speech provider missing streamSynthesize");
      }
      return await provider.streamSynthesize(req);
    },
    synthesizeTelephony: async (req: SpeechTelephonySynthesisRequest) => {
      const provider = await loadXaiSpeechProvider();
      if (!provider.synthesizeTelephony) {
        throw new Error("xAI speech provider missing synthesizeTelephony");
      }
      return await provider.synthesizeTelephony(req);
    },
  };
}

export function createLazyXaiRealtimeTranscriptionProvider(
  context: Pick<
    PluginCapabilityCatalogContext,
    | "isProviderAuthProfileConfigured"
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
    PluginCapabilityCatalogContext,
    "isProviderAuthProfileConfigured" | "resolveAgentDir"
  >,
): RealtimeVoiceProviderPlugin {
  return {
    ...createXaiRealtimeVoiceProviderMetadata(context),
    createBridge: createLazyXaiRealtimeVoiceBridge,
  };
}
