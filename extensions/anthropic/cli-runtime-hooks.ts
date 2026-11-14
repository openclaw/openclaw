import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

// Same overall revision limit as the embedded runner, so a finalize hook cannot loop a turn.
const MAX_FINALIZE_REVISIONS = 3;

export type ClaudeCliFinalizeContext = {
  /** Present when a plugin registers before_agent_finalize; native Stop asks it to settle. */
  runBeforeAgentFinalize?: (stop: {
    stopHookActive: boolean;
    lastAssistantMessage?: string;
    transcriptPath?: string;
    cwd?: string;
  }) => Promise<{ action: "continue" | "finalize" } | { action: "revise"; reason: string }>;
};

export function carriesTurnContext(request: Record<string, unknown>, response: unknown): boolean {
  return (
    request.callback_id === "UserPromptSubmit" &&
    isRecord(response) &&
    isRecord(response.hookSpecificOutput) &&
    response.hookSpecificOutput.additionalContext !== undefined
  );
}

export function privateInputHolds(turn: {
  context: { assertPrivateInputCurrent?: () => void };
}): boolean {
  try {
    turn.context.assertPrivateInputCurrent?.();
    return true;
  } catch {
    return false;
  }
}

/** Answers a native Stop hook with the run's before_agent_finalize decision. */
export async function relayNativeStop(
  turn: { context: ClaudeCliFinalizeContext; finalizeRevisions: number } | undefined,
  input: Record<string, unknown>,
  aborted: boolean,
): Promise<{ decision?: "block"; reason?: string }> {
  const finalize = turn?.context.runBeforeAgentFinalize;
  if (!turn || aborted || !finalize || turn.finalizeRevisions >= MAX_FINALIZE_REVISIONS) {
    return {};
  }
  const decision = await finalize({
    stopHookActive: input.stop_hook_active === true,
    ...(typeof input.last_assistant_message === "string"
      ? { lastAssistantMessage: input.last_assistant_message }
      : {}),
    ...(typeof input.transcript_path === "string" ? { transcriptPath: input.transcript_path } : {}),
    ...(typeof input.cwd === "string" ? { cwd: input.cwd } : {}),
  });
  if (decision.action !== "revise") {
    return {};
  }
  // A blocked Stop keeps the native turn going with the reason as its next instruction.
  turn.finalizeRevisions++;
  return { decision: "block", reason: decision.reason };
}
