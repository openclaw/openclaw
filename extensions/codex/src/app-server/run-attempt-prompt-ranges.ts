import type { EmbeddedRunAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexProjectedContextRange } from "./context-engine-projection.js";

/**
 * An earlier fallback candidate may have frozen this turn's model text. Send those exact
 * bytes in place of this attempt's request, inbound and hook text, as embedded fallbacks do.
 */
export function applyCodexFrozenPrompt(
  params: Pick<
    EmbeddedRunAttemptParamsV2,
    "prompt" | "skipPreparedUserTurnMessage" | "userTurnTranscriptRecorder"
  >,
  promptText: string,
  promptBuild: { prompt: string; promptInputRange?: CodexProjectedContextRange },
): { prompt: string; promptInputRange?: CodexProjectedContextRange; promptText: string } {
  const frozen = params.skipPreparedUserTurnMessage
    ? undefined
    : params.userTurnTranscriptRecorder?.getPersistedMessage?.()?.["__openclaw"]
        ?.modelPromptProjection?.text;
  if (frozen === undefined) {
    return { ...promptBuild, promptText };
  }
  // Projected history ends with the current request; only that tail is replaced.
  const request = promptText.endsWith(params.prompt) ? params.prompt : params.prompt.trim();
  const prompt = promptText.slice(0, promptText.length - request.length) + frozen;
  return { prompt, promptInputRange: { start: 0, end: prompt.length }, promptText: prompt };
}

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
