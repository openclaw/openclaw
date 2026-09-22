import type { ExecApprovalContinuationPromptRange } from "../bash-tools.exec-approval-output.js";

export function rebaseExecApprovalContinuationPromptRange(params: {
  body: string;
  prompt: string;
  range?: ExecApprovalContinuationPromptRange;
}): ExecApprovalContinuationPromptRange | undefined {
  if (!params.range) {
    return undefined;
  }
  if (!params.prompt.endsWith(params.body)) {
    throw new Error("exec approval continuation prompt range could not be rebased");
  }
  const offset = params.prompt.length - params.body.length;
  return {
    start: offset + params.range.start,
    end: offset + params.range.end,
  };
}
