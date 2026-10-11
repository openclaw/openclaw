import { createHash } from "node:crypto";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

// Retain only codec/rate facts from untrusted session receipts, never the session
// instructions, voice, credentials, audio or arbitrary provider fields.
export function readInworldOutputFormat(value: unknown): { type: string; rate?: number } | null {
  if (value === undefined) {
    return null;
  }
  const type = typeof value === "string" ? value : isRecord(value) ? value.type : undefined;
  const codecs = ["audio/pcmu", "audio/pcm", "audio/pcma", "g711_ulaw", "g711_alaw", "pcm16"];
  if (typeof type !== "string" || !codecs.includes(type)) {
    return { type: "[redacted]" };
  }
  const rate = isRecord(value) ? value.rate : undefined;
  return {
    type,
    ...(typeof rate === "number" && Number.isFinite(rate) && rate > 0 ? { rate } : {}),
  };
}

// Stable opaque fingerprints allow reuse correlation without journaling raw IDs.
export function inworldAudioIdFingerprint(id: string | undefined): string | null {
  return id ? createHash("sha256").update(id).digest("hex").slice(0, 16) : null;
}
