import { createHash } from "node:crypto";
import { normalizeProviderId } from "openclaw/plugin-sdk/model-ref-parse";

export function splitDiscordModelRef(modelRef: string): { provider: string; model: string } | null {
  const trimmed = modelRef.trim();
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= trimmed.length - 1) {
    return null;
  }
  const provider = trimmed.slice(0, slashIndex).trim();
  const model = trimmed.slice(slashIndex + 1).trim();
  if (!provider || !model) {
    return null;
  }
  return { provider, model };
}

export function normalizeModelRef(raw?: string): string | null {
  const parsed = splitDiscordModelRef(raw ?? "");
  const provider = parsed ? normalizeProviderId(parsed.provider) : "";
  return parsed && provider ? `${provider}/${parsed.model}` : null;
}

function hashSegment(value: string, length: number): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, length);
}

export function buildPreferenceModelKey(scopeKey: string, modelRef: string): string {
  return `v1:${hashSegment(scopeKey, 32)}:${hashSegment(modelRef, 24)}`;
}

export function preferenceTimestampMs(value: unknown): number {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}
