/**
 * System prompt cache-boundary helpers.
 *
 * Keeps stable prompt prefixes separate from dynamic runtime additions for provider prompt caching.
 */
import { normalizeStructuredPromptSection } from "./prompt-cache-stability.js";

export const SYSTEM_PROMPT_CACHE_BOUNDARY = "\n<!-- OPENCLAW_CACHE_BOUNDARY -->\n";

/**
 * Marks the tail of the dynamic suffix that carries no behavioral guidance:
 * watched sessions and runtime facts. Transports whose tool schemas serialize
 * after the system message may move this tail behind them so the cacheable
 * prefix stays byte-identical across sessions, without lowering the authority
 * of the behavioral guidance that sits above it.
 */
// The marker text is hyphenated rather than underscored on purpose: an
// `OPENCLAW_*` token here would register as a new environment-variable name in
// the `config/env-var-count-budget.txt` ratchet, which is meant to ratchet down.
export const SYSTEM_PROMPT_RELOCATABLE_BOUNDARY = "\n<!-- OPENCLAW-RELOCATABLE-BOUNDARY -->\n";

export function stripSystemPromptCacheBoundary(text: string): string {
  // Both internal markers are stripped here so every existing caller keeps the
  // guarantee that no marker reaches a provider.
  return text
    .replaceAll(SYSTEM_PROMPT_CACHE_BOUNDARY, "\n")
    .replaceAll(SYSTEM_PROMPT_RELOCATABLE_BOUNDARY, "\n");
}

/** Split off the non-behavioral tail a transport may carry past its tool schemas. */
/** Structural comment markers that frame the prompt itself, not relocatable content. */
const TRAILING_PROMPT_MARKERS = /(?:\s*<!--[^>]*-->)+\s*$/u;

export function splitSystemPromptRelocatableBoundary(
  text: string,
): { stablePrefix: string; relocatableSuffix: string } | undefined {
  const split = splitOnBoundary(text, SYSTEM_PROMPT_RELOCATABLE_BOUNDARY);
  if (!split) {
    return undefined;
  }
  // A trailing structural marker closes a section of the system prompt, so it
  // has to stay there; relocating it would both strip the system prompt of its
  // own framing and put an internal marker on a user turn.
  const trailing = TRAILING_PROMPT_MARKERS.exec(split.suffix);
  if (!trailing || trailing.index === 0) {
    return { stablePrefix: split.prefix, relocatableSuffix: split.suffix };
  }
  return {
    stablePrefix: `${split.prefix}\n${trailing[0].trim()}`,
    relocatableSuffix: split.suffix.slice(0, trailing.index).trimEnd(),
  };
}

// Append the cache boundary when a prompt has none (e.g. a hook systemPrompt override),
// so dynamic additions route into an uncached suffix instead of the cached prefix (#85203).
export function ensureSystemPromptCacheBoundary(systemPrompt: string): string {
  if (systemPrompt.trim().length === 0) {
    return systemPrompt;
  }
  return systemPrompt.includes(SYSTEM_PROMPT_CACHE_BOUNDARY)
    ? systemPrompt
    : `${systemPrompt}${SYSTEM_PROMPT_CACHE_BOUNDARY}`;
}

/** Shared marker split so both boundaries stay on one implementation. */
function splitOnBoundary(
  text: string,
  marker: string,
): { prefix: string; suffix: string } | undefined {
  const boundaryIndex = text.indexOf(marker);
  if (boundaryIndex === -1) {
    return undefined;
  }
  return {
    prefix: text.slice(0, boundaryIndex).trimEnd(),
    suffix: text.slice(boundaryIndex + marker.length).trimStart(),
  };
}

export function splitSystemPromptCacheBoundary(
  text: string,
): { stablePrefix: string; dynamicSuffix: string } | undefined {
  const split = splitOnBoundary(text, SYSTEM_PROMPT_CACHE_BOUNDARY);
  return split ? { stablePrefix: split.prefix, dynamicSuffix: split.suffix } : undefined;
}

/**
 * Remove only the relocatable marker, leaving the cache boundary in place for
 * transports that anchor a cache breakpoint on it. Those transports do not
 * relocate anything, so the marker must not survive into their payload.
 */
export function stripSystemPromptRelocatableBoundary(text: string): string {
  return text.replaceAll(SYSTEM_PROMPT_RELOCATABLE_BOUNDARY, "\n");
}

export function prependSystemPromptAdditionAfterCacheBoundary(params: {
  systemPrompt: string;
  systemPromptAddition?: string;
}): string {
  const systemPromptAddition =
    typeof params.systemPromptAddition === "string"
      ? normalizeStructuredPromptSection(params.systemPromptAddition)
      : "";
  if (!systemPromptAddition) {
    return params.systemPrompt;
  }
  if (params.systemPrompt.trim().length === 0) {
    return systemPromptAddition;
  }

  const split = splitSystemPromptCacheBoundary(params.systemPrompt);
  if (!split) {
    return `${systemPromptAddition}\n\n${params.systemPrompt}`;
  }

  const dynamicSuffix = split.dynamicSuffix
    ? normalizeStructuredPromptSection(split.dynamicSuffix)
    : "";
  if (!dynamicSuffix) {
    return `${split.stablePrefix}${SYSTEM_PROMPT_CACHE_BOUNDARY}${systemPromptAddition}`;
  }

  return `${split.stablePrefix}${SYSTEM_PROMPT_CACHE_BOUNDARY}${systemPromptAddition}\n\n${dynamicSuffix}`;
}
