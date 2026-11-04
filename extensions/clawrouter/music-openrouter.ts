import {
  readOpenRouterAudioStream,
  type MusicGenerationRequest,
} from "openclaw/plugin-sdk/music-generation";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ClawRouterCapabilityOffer } from "./capability-offers.js";

export const openRouterMusicModels = new Map([
  ["openrouter/google/lyria-3-pro-preview", "google/lyria-3-pro-preview"],
  ["openrouter/google/lyria-3-clip-preview", "google/lyria-3-clip-preview"],
]);
export const openRouterMusicMode = {
  maxTracks: 1,
  maxDurationSeconds: 180,
  supportsLyrics: true,
  supportsInstrumental: true,
  supportsDuration: true,
  supportsFormat: true,
  supportedFormats: ["mp3", "wav"] as const,
};

export function isClawRouterOpenRouterMusicOffer(offer: ClawRouterCapabilityOffer): boolean {
  const id = normalizeOptionalString(offer.model?.id);
  return (
    id !== undefined &&
    openRouterMusicModels.has(id) &&
    offer.model?.upstream === openRouterMusicModels.get(id) &&
    offer.providerId === "openrouter" &&
    offer.endpoint === "music_generate" &&
    offer.path === "/v1/chat/completions" &&
    (offer.routeKind === "native" || offer.routeKind === "manifest") &&
    offer.methods.length === 1 &&
    offer.methods[0] === "POST" &&
    offer.requestFormat === "openai.chat_completions" &&
    offer.responseFormat === "openai.chat_completions" &&
    Array.isArray(offer.model?.capabilities) &&
    offer.model.capabilities.length === 1 &&
    offer.model.capabilities[0] === "music.generate"
  );
}

export function prepareClawRouterOpenRouterMusic(req: MusicGenerationRequest) {
  const model = openRouterMusicModels.get(req.model);
  if (!model || req.inputImages?.length) {
    throw new Error("Select a qualified text-only ClawRouter OpenRouter music offer.");
  }
  if (
    (req.format !== undefined && req.format !== "mp3" && req.format !== "wav") ||
    (req.durationSeconds !== undefined &&
      (!Number.isInteger(req.durationSeconds) ||
        req.durationSeconds < 1 ||
        req.durationSeconds > 180))
  ) {
    throw new Error("Unsupported format or requested duration for ClawRouter OpenRouter music.");
  }
  const parts = [req.prompt.trim()];
  const lyrics = normalizeOptionalString(req.lyrics);
  if (req.instrumental === true) {
    parts.push("Instrumental only. No vocals, no sung lyrics, no spoken word.");
  }
  if (lyrics) {
    parts.push(`Lyrics:\n${lyrics}`);
  }
  if (req.durationSeconds !== undefined) {
    parts.push(`Target duration: about ${Math.round(req.durationSeconds)} seconds.`);
  }
  const prompt = parts.join("\n\n");
  if (!parts[0] || prompt.length > 32768) {
    throw new Error("ClawRouter OpenRouter music requires a bounded nonempty prompt.");
  }
  return {
    model,
    messages: [{ role: "user", content: prompt }],
    modalities: ["text", "audio"],
    audio: { format: req.format ?? "wav" },
    stream: true,
  };
}

export async function readClawRouterOpenRouterMusic(
  response: Response,
  req: MusicGenerationRequest,
  remaining: () => number,
) {
  const result = await readOpenRouterAudioStream(response, 16 * 1024 * 1024, {
    maxWireBytes: 32 * 1024 * 1024,
    maxTranscriptBytes: 1024 * 1024,
    requireEof: true,
    signal: req.signal,
    timeoutMs: remaining,
  });
  if (!result.audioBuffer.length) {
    throw new Error("ClawRouter OpenRouter music returned no complete audio.");
  }
  const format = req.format ?? "wav";
  return {
    tracks: [
      {
        buffer: result.audioBuffer,
        mimeType: format === "mp3" ? "audio/mpeg" : "audio/wav",
        fileName: `track-1.${format}`,
      },
    ],
    ...(result.transcript ? { lyrics: [result.transcript] } : {}),
  };
}
