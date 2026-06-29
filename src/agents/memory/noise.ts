// Shared conservative noise classification for durable conversational memory.
// Richer suppression belongs to the Phase 3 dreaming/segmentation pass.

const SILENT_PREFIX = /^\s*\[SILENT\]/;

export type MemoryNoiseLike = {
  content?: string | null;
  channel?: string | null;
  noiseClass?: string | null;
  noise_class?: string | null;
};

export function isSuppressedMemoryNoise(value: MemoryNoiseLike): boolean {
  const noiseClass = value.noiseClass ?? value.noise_class;
  if (noiseClass === "suppressed") {
    return true;
  }
  if (value.channel === "heartbeat") {
    return true;
  }
  return SILENT_PREFIX.test(value.content ?? "");
}
