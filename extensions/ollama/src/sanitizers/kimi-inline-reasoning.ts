import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

const INLINE_REASONING_MIN_PREFIX_CHARS = 80;
const INLINE_REASONING_MAX_PENDING_CHARS = 512;
const INLINE_REASONING_BOUNDARY_RE = /(^|\s)\uFE0F\s*/u;

export function isOllamaCloudKimiModelRef(modelId: string): boolean {
  const normalizedModelId = normalizeLowercaseStringOrEmpty(modelId);
  const slashIndex = normalizedModelId.indexOf("/");
  const normalizedWireModelId =
    slashIndex === -1 ? normalizedModelId : normalizedModelId.slice(slashIndex + 1);
  return normalizedWireModelId.startsWith("kimi-k") && normalizedWireModelId.includes(":cloud");
}

export function createKimiInlineReasoningSanitizer() {
  let bypassInlineReasoning = false;

  return (params: { text: string; final: boolean }): string | undefined => {
    if (bypassInlineReasoning) {
      return params.text;
    }

    const match = INLINE_REASONING_BOUNDARY_RE.exec(params.text);
    if (!match || match[1] === undefined) {
      if (!params.final && params.text.length <= INLINE_REASONING_MAX_PENDING_CHARS) {
        return undefined;
      }
      if (!params.final && params.text.length > INLINE_REASONING_MAX_PENDING_CHARS) {
        bypassInlineReasoning = true;
      }
      return params.text;
    }

    const boundaryStartIndex = match.index + match[1].length;
    const boundaryEndIndex = match.index + match[0].length;
    const prefix = params.text.slice(0, boundaryStartIndex).trim();
    const answer = params.text.slice(boundaryEndIndex).trim();
    if (prefix.length >= INLINE_REASONING_MIN_PREFIX_CHARS) {
      return answer;
    }

    return params.final ? params.text : undefined;
  };
}
