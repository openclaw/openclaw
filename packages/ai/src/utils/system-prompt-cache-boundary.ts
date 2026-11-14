import type { Context, PreparedSystemPrompt } from "@openclaw/llm-core";
import { normalizeStructuredPromptSection } from "./prompt-cache-stability.js";
import { sanitizeSurrogates } from "./sanitize-unicode.js";

export const SYSTEM_PROMPT_CACHE_BOUNDARY = "\n<!-- OPENCLAW_CACHE_BOUNDARY -->\n";

/** Producer-delimited Runtime facts; instructions must remain outside this region. */
export const SYSTEM_PROMPT_RELOCATABLE_BOUNDARY = "\n<!-- OPENCLAW-RELOCATABLE-BOUNDARY -->\n";
export const SYSTEM_PROMPT_RELOCATABLE_BOUNDARY_END = "\n<!-- /OPENCLAW-RELOCATABLE-BOUNDARY -->";

// Request conversion and egress observation strip the same session prompt every turn.
const strippedSystemPrompts = new Map<string, string>();
const MAX_STRIPPED_SYSTEM_PROMPTS = 32;

/** Carry this fact with its session; interleaved sessions cannot evict a live revision. */
export function prepareSystemPrompt(
  text: string,
  previous?: PreparedSystemPrompt,
): PreparedSystemPrompt {
  if (previous?.text === text) {
    return previous;
  }
  let stripped: string | undefined;
  let instructions: string | undefined;
  return Object.freeze({
    text,
    get stripped() {
      return (stripped ??= stripSystemPromptCacheBoundary(text));
    },
    get instructions() {
      return (instructions ??= sanitizeSurrogates(this.stripped));
    },
  });
}

/** A stream's boundary transform carries the revision it actually passes downstream. */
export function createSystemPromptCacheBoundaryStripper() {
  let prepared: PreparedSystemPrompt | undefined;
  return <T extends Pick<Context, "systemPrompt" | "preparedSystemPrompt">>(context: T): T => {
    if (!context.systemPrompt) {
      return context;
    }
    const stripped = prepareSystemPrompt(
      context.systemPrompt,
      context.preparedSystemPrompt,
    ).stripped;
    prepared = prepareSystemPrompt(stripped, prepared);
    return { ...context, systemPrompt: stripped, preparedSystemPrompt: prepared };
  };
}

export function stripSystemPromptCacheBoundary(text: string): string {
  let stripped = strippedSystemPrompts.get(text);
  if (stripped === undefined) {
    // Marker removal is ordered: one removal can join text into the next marker.
    stripped = stripSystemPromptRelocatableBoundary(
      text
        .replaceAll(SYSTEM_PROMPT_CACHE_BOUNDARY, "\n")
        .replaceAll(SYSTEM_PROMPT_CACHE_BOUNDARY.trim(), ""),
    );
    for (const oldest of strippedSystemPrompts.keys()) {
      if (strippedSystemPrompts.size < MAX_STRIPPED_SYSTEM_PROMPTS) {
        break;
      }
      strippedSystemPrompts.delete(oldest);
    }
    strippedSystemPrompts.set(text, stripped);
  }
  return stripped;
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
  return `${split.stablePrefix}${SYSTEM_PROMPT_CACHE_BOUNDARY}${systemPromptAddition}${dynamicSuffix ? `\n\n${dynamicSuffix}` : ""}`;
}
