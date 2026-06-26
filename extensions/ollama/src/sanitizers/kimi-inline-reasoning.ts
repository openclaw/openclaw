// Ollama plugin module implements kimi inline reasoning behavior.
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  OllamaVisibleContentSanitizer,
  OllamaVisibleContentStreamResolution,
} from "./visible-content-contract.js";

const INLINE_REASONING_MIN_PREFIX_CHARS = 80;
const INLINE_REASONING_MAX_PENDING_CHARS = 512;
const INLINE_REASONING_BOUNDARY_RE = /(^|\s)\uFE0F\s*/u;
const MARKERLESS_REASONING_BOUNDARY_RE = /\n\s*\n/u;
const MARKERLESS_REASONING_PREFIX_RE =
  /^The user is\b(?=[\s\S]*\b(?:(?:my|[A-Za-z]+(?:'s|')?) previous response|conversation history|previous message)\b)/iu;
const MARKERLESS_REASONING_PLANNING_RE = /\bI should\b/iu;

type InlineReasoningVisibleTextResolution =
  | { kind: "visible"; text: string; bypassInlineReasoning?: boolean }
  | { kind: "pending" };

export function isOllamaCloudKimiModelRef(modelId: string): boolean {
  const normalizedModelId = normalizeLowercaseStringOrEmpty(modelId);
  const slashIndex = normalizedModelId.indexOf("/");
  const normalizedWireModelId =
    slashIndex === -1 ? normalizedModelId : normalizedModelId.slice(slashIndex + 1);
  return normalizedWireModelId.startsWith("kimi-k") && normalizedWireModelId.includes(":cloud");
}

function resolveInlineReasoningVisibleText(params: {
  text: string;
  final: boolean;
}): InlineReasoningVisibleTextResolution {
  const match = INLINE_REASONING_BOUNDARY_RE.exec(params.text);
  if (!match) {
    const markerlessResolution = resolveMarkerlessReasoningVisibleText(params.text);
    if (markerlessResolution) {
      return markerlessResolution;
    }

    if (!params.final && params.text.length <= INLINE_REASONING_MAX_PENDING_CHARS) {
      return { kind: "pending" };
    }
    return {
      kind: "visible",
      text: params.text,
      bypassInlineReasoning:
        !params.final && params.text.length > INLINE_REASONING_MAX_PENDING_CHARS,
    };
  }

  const boundaryStartIndex = match.index + match[1].length;
  const boundaryEndIndex = match.index + match[0].length;
  const prefix = params.text.slice(0, boundaryStartIndex).trim();
  const answer = params.text.slice(boundaryEndIndex).trim();
  if (prefix.length >= INLINE_REASONING_MIN_PREFIX_CHARS) {
    return { kind: "visible", text: answer };
  }

  return params.final ? { kind: "visible", text: params.text } : { kind: "pending" };
}

function resolveMarkerlessReasoningVisibleText(
  text: string,
): InlineReasoningVisibleTextResolution | undefined {
  const match = MARKERLESS_REASONING_BOUNDARY_RE.exec(text);
  if (!match) {
    return undefined;
  }

  const prefix = text.slice(0, match.index).trim();
  const answer = text.slice(match.index + match[0].length).trim();
  if (
    prefix.length < INLINE_REASONING_MIN_PREFIX_CHARS ||
    !MARKERLESS_REASONING_PREFIX_RE.test(prefix) ||
    !containsUnquotedMarkerlessPlanningPhrase(prefix)
  ) {
    return undefined;
  }

  return { kind: "visible", text: answer };
}

function containsUnquotedMarkerlessPlanningPhrase(text: string): boolean {
  let quoted = false;
  let candidate = "";
  for (const char of text) {
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) {
      continue;
    }
    candidate += char;
  }
  return MARKERLESS_REASONING_PLANNING_RE.test(candidate);
}

export function createKimiInlineReasoningSanitizer(): OllamaVisibleContentSanitizer {
  let bypassInlineReasoning = false;

  return {
    resolveStreamText(params): OllamaVisibleContentStreamResolution {
      if (bypassInlineReasoning) {
        return { kind: "visible", text: params.text };
      }

      const resolution = resolveInlineReasoningVisibleText(params);
      if (resolution.kind === "pending") {
        return resolution;
      }
      if (resolution.bypassInlineReasoning) {
        bypassInlineReasoning = true;
      }
      return { kind: "visible", text: resolution.text };
    },
    sanitizeFinalText(text) {
      const resolution = resolveInlineReasoningVisibleText({ text, final: true });
      return resolution.kind === "visible" ? resolution.text : text;
    },
  };
}
