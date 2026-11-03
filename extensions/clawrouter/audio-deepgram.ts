import type { AudioTranscriptionRequest } from "openclaw/plugin-sdk/media-understanding";

const booleanOptions = new Set([
  "smart_format",
  "punctuate",
  "diarize",
  "utterances",
  "multichannel",
  "numerals",
  "detect_entities",
  "sentiment",
  "topics",
  "intents",
  "filler_words",
  "paragraphs",
  "profanity_filter",
]);
const repeatedOptions = new Set(["keyterm", "keywords", "replace", "redact", "tag"]);
const scalarOptions = new Set([
  "language",
  "encoding",
  "sample_rate",
  "channels",
  "detect_language",
  "summarize",
  "utt_split",
]);

// Only the published synchronous file contract is eligible; Flux/callbacks need another lifecycle.
export function validateClawRouterDeepgramAudio(
  input: Pick<AudioTranscriptionRequest, "query" | "language" | "prompt" | "mime">,
): void {
  if (input.prompt?.trim())
    throw new Error("ClawRouter Deepgram does not support transcription prompts; use keyterm");
  const mime = input.mime?.trim().toLowerCase() || "application/octet-stream";
  if (!/^audio\/[a-z0-9.+-]+$/.test(mime) && mime !== "application/octet-stream") {
    throw new Error("ClawRouter Deepgram requires native binary audio MIME");
  }
  const query = new URLSearchParams({ model: "nova-3" });
  if (input.language?.trim()) query.set("language", input.language.trim());
  for (const [name, value] of Object.entries(input.query ?? {})) {
    if (!booleanOptions.has(name) && !repeatedOptions.has(name) && !scalarOptions.has(name)) {
      throw new Error("ClawRouter Deepgram query option is outside the synchronous file contract");
    }
    if (Array.isArray(value)) {
      if (!repeatedOptions.has(name))
        throw new Error("ClawRouter Deepgram scalar query cannot repeat");
      query.delete(name);
      for (const item of value) query.append(name, item);
    } else {
      query.set(name, String(value));
    }
  }
  if (query.toString().length > 16384 || [...query].length > 128) {
    throw new Error("ClawRouter Deepgram query exceeds bounded native input");
  }
  for (const [name, value] of query) {
    if (!value || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new Error("ClawRouter Deepgram query value is invalid");
    }
    if (booleanOptions.has(name) && value !== "true" && value !== "false") {
      throw new Error("ClawRouter Deepgram boolean option is invalid");
    }
    if (
      ["sample_rate", "channels"].includes(name) &&
      (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))
    ) {
      throw new Error("ClawRouter Deepgram audio format number is invalid");
    }
  }
}
