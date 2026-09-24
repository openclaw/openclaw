/**
 * System prompt cache-boundary helpers.
 *
 * Keeps stable prompt prefixes separate from dynamic runtime additions for provider prompt caching.
 */
import { normalizeStructuredPromptSection } from "./prompt-cache-stability.js";

export const SYSTEM_PROMPT_CACHE_BOUNDARY = "\n<!-- OPENCLAW_CACHE_BOUNDARY -->\n";

/** Producer-delimited Runtime facts; instructions must remain outside this region. */
export const SYSTEM_PROMPT_RELOCATABLE_BOUNDARY = "\n<!-- OPENCLAW-RELOCATABLE-BOUNDARY -->\n";
export const SYSTEM_PROMPT_RELOCATABLE_BOUNDARY_END = "\n<!-- /OPENCLAW-RELOCATABLE-BOUNDARY -->";

export function stripSystemPromptCacheBoundary(text: string): string {
  return stripSystemPromptRelocatableBoundary(
    text
      .replaceAll(SYSTEM_PROMPT_CACHE_BOUNDARY, "\n")
      .replaceAll(SYSTEM_PROMPT_CACHE_BOUNDARY.trim(), ""),
  );
}

/** Reject ambiguous markers from workspace or hook text instead of moving instructions. */
export function splitSystemPromptRelocatableBoundary(
  text: string,
): { remainingPrompt: string; relocatable: string } | undefined {
  const opening = SYSTEM_PROMPT_RELOCATABLE_BOUNDARY.trim();
  const closing = SYSTEM_PROMPT_RELOCATABLE_BOUNDARY_END.trim();
  const start = text.indexOf(opening);
  const end = text.indexOf(closing);
  if (
    start === -1 ||
    end < start ||
    text.includes(opening, start + opening.length) ||
    text.includes(closing, end + closing.length)
  ) {
    return undefined;
  }
  return {
    remainingPrompt: [text.slice(0, start).trimEnd(), text.slice(end + closing.length).trimStart()]
      .filter(Boolean)
      .join("\n"),
    relocatable: text.slice(start + opening.length, end).trim(),
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

export function splitSystemPromptCacheBoundary(
  text: string,
): { stablePrefix: string; dynamicSuffix: string } | undefined {
  const boundaryIndex = text.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
  if (boundaryIndex === -1) {
    return undefined;
  }
  return {
    stablePrefix: text.slice(0, boundaryIndex).trimEnd(),
    dynamicSuffix: text.slice(boundaryIndex + SYSTEM_PROMPT_CACHE_BOUNDARY.length).trimStart(),
  };
}

/** Keep explicit cache breakpoints while removing relocation metadata. */
export function stripSystemPromptRelocatableBoundary(text: string): string {
  // The closing marker carries its own leading newline and is dropped whole:
  // the prompt builder closes the region on its last line, so substituting a
  // newline there would leave trailing whitespace the prompt never had.
  return text
    .replaceAll(SYSTEM_PROMPT_RELOCATABLE_BOUNDARY, "\n")
    .replaceAll(SYSTEM_PROMPT_RELOCATABLE_BOUNDARY_END, "")
    .replaceAll(SYSTEM_PROMPT_RELOCATABLE_BOUNDARY.trim(), "")
    .replaceAll(SYSTEM_PROMPT_RELOCATABLE_BOUNDARY_END.trim(), "");
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
