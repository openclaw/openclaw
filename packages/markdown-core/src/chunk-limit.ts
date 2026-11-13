import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";

/**
 * Normalizes a caller-supplied chunk limit to this package's single contract: a positive
 * finite limit becomes an integer progress step, and every other value (NaN, zero,
 * negative, infinite) is returned so it stays non-positive or non-finite.
 *
 * Callers treat those values as "no usable cap" and emit one unsplit chunk. Coercing them
 * to a step of 1 instead would shatter a message into one chunk per character, which
 * readers see as dozens of separate messages.
 *
 * Kept out of the package barrel: both chunkers read limits through it, but it is not part
 * of the public surface.
 */
export function normalizeChunkLimit(limit: number): number {
  if (Number.isNaN(limit)) {
    return 0;
  }
  // String slicing truncates fractional indexes, so positive limits need an integer progress step.
  return Number.isFinite(limit) && limit > 0 ? resolveIntegerOption(limit, 1, { min: 1 }) : limit;
}
