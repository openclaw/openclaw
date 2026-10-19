import type { ResolvedCliBackend } from "../cli-backends.js";
import type { CliOutput } from "../cli-output-contracts.js";
import { formatCliOutputError } from "../cli-output.js";
import { FailoverError, resolveFailoverStatus } from "../failover-error.js";
import { classifyFailoverReason } from "../failover/classify.js";

export function createCliOutputFailoverError(params: {
  output: CliOutput;
  provider: string;
  model: string;
  runId?: string;
  sessionId?: string;
  lane?: string;
  classifyErrorCode?: ResolvedCliBackend["classifyErrorCode"];
}): FailoverError | undefined {
  if (!params.output.errorText) {
    return undefined;
  }
  const message = formatCliOutputError(params.output, {
    runId: params.runId,
    sessionId: params.sessionId,
  });
  const terminalFailure = params.output.terminalFailure?.reason;
  // Record terminal facts before provider hooks can throw or reclassify them;
  // losing a max-turn stop here could replay tools in another model attempt.
  const reason = terminalFailure
    ? terminalFailure === "synthetic_no_response"
      ? "format"
      : "unknown"
    : (classifyFailoverReason(message, { provider: params.provider }) ?? "unknown");
  const code = terminalFailure
    ? `cli_${terminalFailure}`
    : reason === "context_overflow"
      ? "cli_context_overflow"
      : params.classifyErrorCode?.(params.output.errorText);
  return new FailoverError(message, {
    reason,
    provider: params.provider,
    model: params.model,
    sessionId: params.sessionId,
    lane: params.lane,
    status: resolveFailoverStatus(reason),
    code,
    rawError: params.output.errorText,
  });
}
