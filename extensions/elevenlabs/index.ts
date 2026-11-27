import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  assertOkOrThrowHttpError,
  buildAudioTranscriptionFormData,
  postTranscriptionRequest,
  readProviderJsonObjectResponse,
  resolveProviderHttpRequestConfig,
  requireTranscriptionText,
} from "openclaw/plugin-sdk/provider-http";
import { buildElevenLabsRealtimeTranscriptionProvider } from "./realtime-transcription-provider-factory.js";
import { DEFAULT_ELEVENLABS_BASE_URL, normalizeElevenLabsBaseUrl } from "./shared.js";
import { buildElevenLabsSpeechProvider } from "./speech-provider-factory.js";

const DEFAULT_ELEVENLABS_STT_MODEL = "scribe_v2";

export default definePluginEntry({
  id: "elevenlabs",
  name: "ElevenLabs Speech",
  description: "Bundled ElevenLabs speech provider",
  register(api) {
    api.registerSpeechProvider(buildElevenLabsSpeechProvider);
    api.registerMediaUnderstandingProvider({
      id: "elevenlabs",
      capabilities: ["audio"],
      defaultModels: { audio: DEFAULT_ELEVENLABS_STT_MODEL },
      autoPriority: { audio: 45 },
      async transcribeAudio(req) {
        const fetchFn = req.fetchFn ?? fetch;
        const apiKey = req.apiKey || process.env.ELEVENLABS_API_KEY || process.env.XI_API_KEY;
        if (!apiKey) {
          throw new Error("ElevenLabs API key missing");
        }

        const model = req.model?.trim() || DEFAULT_ELEVENLABS_STT_MODEL;
        const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
          resolveProviderHttpRequestConfig({
            baseUrl: normalizeElevenLabsBaseUrl(req.baseUrl),
            defaultBaseUrl: DEFAULT_ELEVENLABS_BASE_URL,
            headers: req.headers,
            request: req.request,
            defaultHeaders: {
              "xi-api-key": apiKey,
            },
            provider: "elevenlabs",
            api: "elevenlabs-speech-to-text",
            capability: "audio",
            transport: "media-understanding",
          });
        const form = buildAudioTranscriptionFormData({
          buffer: req.buffer,
          fileName: req.fileName,
          mime: req.mime,
          fields: {
            model_id: model,
            language_code: req.language,
            prompt: req.prompt,
          },
        });
        for (const key of ["no_verbatim", "tag_audio_events", "diarize"]) {
          const value = req.query?.[key];
          if (
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean"
          ) {
            form.set(key, String(value));
          }
        }
        const { response, release } = await postTranscriptionRequest({
          url: `${baseUrl}/v1/speech-to-text`,
          headers,
          body: form,
          timeoutMs: req.timeoutMs,
          ...(req.signal ? { signal: req.signal } : {}),
          fetchFn,
          allowPrivateNetwork,
          dispatcherPolicy,
          auditContext: "elevenlabs speech-to-text",
        });

        try {
          await assertOkOrThrowHttpError(response, "ElevenLabs audio transcription failed");
          const payload = await readProviderJsonObjectResponse(
            response,
            "ElevenLabs audio transcription failed",
          );
          const text = requireTranscriptionText(
            payload.text,
            "ElevenLabs audio transcription response missing text",
          );
          return { text, model };
        } finally {
          await release();
        }
      },
    });
    api.registerRealtimeTranscriptionProvider(buildElevenLabsRealtimeTranscriptionProvider);
  },
});
