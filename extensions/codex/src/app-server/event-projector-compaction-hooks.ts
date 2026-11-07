import {
  getAgentHarnessHookRunner,
  runAgentHarnessAfterCompactionHook,
  runAgentHarnessBeforeCompactionHook,
  type AgentMessage,
} from "openclaw/plugin-sdk/agent-harness-runtime";

/**
 * Runs a Codex compaction hook with the mirrored session history. The read is
 * history-sized, so it happens only when a plugin listens, as on the embedded
 * compaction path; a projection that stops during the read skips the hook.
 */
export async function runCodexCompactionHook(params: {
  hook: "before_compaction" | "after_compaction";
  readMessages: () => Promise<AgentMessage[]>;
  isActive: () => boolean;
  sessionFile: string;
  ctx: Parameters<typeof runAgentHarnessBeforeCompactionHook>[0]["ctx"];
}): Promise<void> {
  if (!getAgentHarnessHookRunner()?.hasHooks(params.hook)) {
    return;
  }
  const messages = await params.readMessages();
  if (!params.isActive()) {
    return;
  }
  const { sessionFile, ctx } = params;
  if (params.hook === "before_compaction") {
    await runAgentHarnessBeforeCompactionHook({ sessionFile, messages, ctx });
  } else {
    await runAgentHarnessAfterCompactionHook({ sessionFile, messages, compactedCount: -1, ctx });
  }
}
