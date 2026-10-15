import type { UserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.types.js";
import {
  resizeExecApprovalContinuationPrompt,
  type ExecApprovalContinuationPromptRange,
} from "../../bash-tools.exec-approval-output.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../defaults.js";
import { resolveLiveToolResultMaxChars } from "../../tool-result-limits.js";

export function prepareExecApprovalContinuationForAttempt(params: {
  prompt: string;
  transcriptPrompt?: string;
  promptRange?: ExecApprovalContinuationPromptRange;
  transcriptPromptRange?: ExecApprovalContinuationPromptRange;
  contextTokenBudget?: number;
  modelContextWindow?: number;
  modelMaxTokens?: number;
  userTurnTranscriptRecorder?: UserTurnTranscriptRecorder;
}): { prompt: string; transcriptPrompt?: string } {
  const promptRange = params.promptRange;
  if (!promptRange) {
    return { prompt: params.prompt, transcriptPrompt: params.transcriptPrompt };
  }
  const contextWindowTokens = Math.max(
    1,
    Math.floor(
      params.contextTokenBudget ??
        params.modelContextWindow ??
        params.modelMaxTokens ??
        DEFAULT_CONTEXT_TOKENS,
    ),
  );
  const maxOutputUtf16Units = resolveLiveToolResultMaxChars({ contextWindowTokens });
  const resize = (prompt: string, range = promptRange) =>
    resizeExecApprovalContinuationPrompt({ prompt, range, maxOutputUtf16Units });
  const prompt = resize(params.prompt);
  const transcriptPrompt =
    params.transcriptPrompt === undefined
      ? undefined
      : resize(params.transcriptPrompt, params.transcriptPromptRange ?? promptRange);
  params.userTurnTranscriptRecorder?.replaceTextBeforePersistence?.(transcriptPrompt ?? prompt);
  return { prompt, transcriptPrompt };
}
