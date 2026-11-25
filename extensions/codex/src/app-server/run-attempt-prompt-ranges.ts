import type { EmbeddedRunAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexProjectedContextRange } from "./context-engine-projection.js";

/**
 * An earlier fallback candidate may have frozen this turn's model text. Send those exact bytes
 * in place of this attempt's request, as embedded fallbacks do; this attempt's inbound and hook
 * context stay around them, like embedded fallback runtime context. Bind before this attempt
 * captures its own projection, so same-attempt native retries keep their original input.
 */
export function bindCodexFrozenPrompt(
  params: Pick<
    EmbeddedRunAttemptParamsV2,
    "prompt" | "skipPreparedUserTurnMessage" | "userTurnTranscriptRecorder"
  >,
) {
  const projection = params.skipPreparedUserTurnMessage
    ? undefined
    : params.userTurnTranscriptRecorder?.getPersistedMessage?.()?.["__openclaw"]
        ?.modelPromptProjection;
  const frozen =
    projection && typeof projection === "object" && "text" in projection
      ? projection.text
      : undefined;
  return (
    promptText: string,
    promptBuild: { prompt: string; promptInputRange?: CodexProjectedContextRange },
  ): {
    prompt: string;
    promptInputRange: CodexProjectedContextRange | undefined;
    promptText: string;
  } => {
    const { prompt, promptInputRange } = promptBuild;
    if (typeof frozen !== "string") {
      return { prompt, promptInputRange, promptText };
    }
    // The hook input ends with the projected prompt, which ends with the current request.
    const request = promptText.endsWith(params.prompt) ? params.prompt : params.prompt.trim();
    const { start, end } = promptInputRange ?? { start: 0, end: prompt.length };
    const requestStart = end - request.length;
    return {
      prompt: prompt.slice(0, requestStart) + frozen + prompt.slice(end),
      promptInputRange: { start, end: requestStart + frozen.length },
      promptText: promptText.slice(0, promptText.length - request.length) + frozen,
    };
  };
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
