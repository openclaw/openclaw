import type {
  AudioTranscriptionRequest,
  AudioTranscriptionResult,
  MediaUnderstandingProvider,
} from "openclaw/plugin-sdk/media-understanding";
import { transcribeAudio } from "./stt.js";

const DEFAULT_REGION = "us-east-1";

type TranscribeConfig = {
  enabled: boolean;
  region: string;
  languageCode?: string;
};

function readTranscribeConfig(raw: Record<string, unknown>): TranscribeConfig {
  const enabled = raw.enabled;
  return {
    enabled: enabled !== false,
    region: (typeof raw.region === "string" && raw.region.trim()) ? raw.region.trim() : DEFAULT_REGION,
    languageCode: typeof raw.languageCode === "string" && raw.languageCode.trim()
      ? raw.languageCode.trim()
      : undefined,
  };
}

async function transcribe(
  req: AudioTranscriptionRequest,
  config: TranscribeConfig,
): Promise<AudioTranscriptionResult> {
  const text = await transcribeAudio({
    buffer: req.buffer,
    mime: req.mime,
    language: req.language ?? config.languageCode,
    region: config.region,
    timeoutMs: req.timeoutMs,
  });

  return { text, model: "amazon-transcribe-streaming" };
}

/**
 * Build the Amazon Transcribe media understanding provider.
 * Config is read from the parent `amazon` plugin's `transcribe` key.
 */
export function buildTranscribeMediaProvider(
  pluginConfig?: Record<string, unknown>,
): MediaUnderstandingProvider {
  const config = readTranscribeConfig(
    (pluginConfig?.transcribe ?? {}) as Record<string, unknown>,
  );

  return {
    id: "amazon-transcribe",
    capabilities: ["audio"],
    defaultModels: { audio: "amazon-transcribe-streaming" },
    autoPriority: { audio: 25 },
    transcribeAudio: (req) => transcribe(req, config),
  };
}
