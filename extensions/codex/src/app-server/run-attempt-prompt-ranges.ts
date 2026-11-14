import type { CodexProjectedContextRange } from "./context-engine-projection.js";

/**
 * Locate the input, projected context, and current request inside the decorated turn
 * prompt. Ranges are omitted when hooks or decoration moved the projected prompt text.
 */
export function resolveCodexShiftedPromptRanges(params: {
  prompt: string;
  promptInputRange: { start: number; end: number } | undefined;
  turnPromptText: string;
  promptText: string;
  promptContextRange: CodexProjectedContextRange | undefined;
}): {
  inputRange?: CodexProjectedContextRange;
  contextRange?: CodexProjectedContextRange;
  requestRange?: CodexProjectedContextRange;
} {
  const { prompt, promptInputRange, turnPromptText, promptText, promptContextRange } = params;
  if (
    !promptInputRange ||
    promptInputRange.start < 0 ||
    promptInputRange.end < promptInputRange.start ||
    promptInputRange.end > prompt.length ||
    !turnPromptText.endsWith(prompt)
  ) {
    return {};
  }
  const turnPromptOffset = turnPromptText.length - prompt.length;
  const inputRange = {
    start: turnPromptOffset + promptInputRange.start,
    end: turnPromptOffset + promptInputRange.end,
  };
  const promptTextInputOffset = promptInputRange.end - promptText.length;
  if (
    !promptContextRange ||
    promptTextInputOffset < promptInputRange.start ||
    prompt.slice(promptTextInputOffset, promptInputRange.end) !== promptText
  ) {
    return { inputRange };
  }
  const promptTextOffset = prompt.endsWith(promptText)
    ? prompt.length - promptText.length
    : promptTextInputOffset;
  const contextOffset = turnPromptOffset + promptTextOffset;
  const contextRange = {
    start: contextOffset + promptContextRange.start,
    end: contextOffset + promptContextRange.end,
  };
  return {
    inputRange,
    contextRange,
    requestRange: { start: contextRange.end, end: contextOffset + promptText.length },
  };
}
