import path from "node:path";
import type {
  AudioTranscriptionRequest,
  AudioTranscriptionResult,
  MediaUnderstandingProvider,
} from "openclaw/plugin-sdk/media-understanding";
import { normalizeElevenLabsBaseUrl } from "./shared.js";

const DEFAULT_ELEVENLABS_STT_MODEL = "scribe_v2";

function resolveUploadFileName(fileName?: string, mime?: string): string {
  const trimmed = fileName?.trim();
  const baseName = trimmed ? path.basename(trimmed) : "audio";
  const lowerMime = mime?.trim().toLowerCase();

  if (/\.aac$/i.test(baseName)) {
    return `${baseName.slice(0, -4) || "audio"}.m4a`;
  }
  if (!path.extname(baseName) && lowerMime === "audio/aac") {
    return `${baseName || "audio"}.m4a`;
  }
  return baseName;
}

async function readErrorDetail(res: Response): Promise<string | undefined> {
  const text = (await res.text()).trim();
  if (!text) {
    return undefined;
  }
  try {
    const json = JSON.parse(text) as {
      detail?: { message?: string; detail?: string; status?: string; code?: string };
      message?: string;
      error?: string;
    };
    return (
      json.message ??
      json.detail?.message ??
      json.detail?.detail ??
      json.error ??
      json.detail?.status ??
      json.detail?.code
    );
  } catch {
    return text.slice(0, 300);
  }
}

export async function transcribeElevenLabsAudio(
  req: AudioTranscriptionRequest,
): Promise<AudioTranscriptionResult> {
  const fetchFn = req.fetchFn ?? fetch;
  const apiKey = req.apiKey || process.env.ELEVENLABS_API_KEY || process.env.XI_API_KEY;
  if (!apiKey) {
    throw new Error("ElevenLabs API key missing");
  }

  const model = req.model?.trim() || DEFAULT_ELEVENLABS_STT_MODEL;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), req.timeoutMs);

  try {
    const form = new FormData();
    const bytes = new Uint8Array(req.buffer);
    const blob = new Blob([bytes], { type: req.mime ?? "application/octet-stream" });
    form.append("file", blob, resolveUploadFileName(req.fileName, req.mime));
    form.append("model_id", model);
    if (req.language?.trim()) {
      form.append("language_code", req.language.trim());
    }
    if (req.prompt?.trim()) {
      form.append("prompt", req.prompt.trim());
    }

    const res = await fetchFn(`${normalizeElevenLabsBaseUrl(req.baseUrl)}/v1/speech-to-text`, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
      },
      body: form,
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await readErrorDetail(res);
      throw new Error(
        `ElevenLabs audio transcription failed (${res.status})${detail ? `: ${detail}` : ""}`,
      );
    }

    const payload = (await res.json()) as { text?: string };
    const text = payload.text?.trim();
    if (!text) {
      throw new Error("ElevenLabs audio transcription response missing text");
    }
    return { text, model };
  } finally {
    clearTimeout(timeout);
  }
}

export const elevenLabsMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "elevenlabs",
  capabilities: ["audio"],
  defaultModels: { audio: DEFAULT_ELEVENLABS_STT_MODEL },
  autoPriority: { audio: 45 },
  transcribeAudio: transcribeElevenLabsAudio,
};
