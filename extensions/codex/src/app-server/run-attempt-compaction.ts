import { embeddedAgentLog, formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexAttemptResources } from "./run-attempt-resources.js";
import { restoreCodexThreadSkillsCatalogAfterCompaction } from "./thread-policy.js";

/** Restore host-owned context after native compaction rebuilds a live thread. */
export async function restoreCodexAttemptCompactionContext(
  resources: CodexAttemptResources,
): Promise<void> {
  const { state, prompt } = resources;
  const { runtime, attemptTools } = prompt.context;
  const { connection } = runtime;
  const { params, runAbortController } = connection;
  const { computerContextEpoch, compactionPlanState } = attemptTools;
  const { client, thread } = state;
  const assertCurrent = () => {
    params.hostCapabilities.assertActive();
    connection.assertCurrent();
    thread.liveThreadOwnership?.assertCurrent();
    if (state.thread !== thread || state.client !== client) {
      throw new Error("Codex compaction thread ownership changed");
    }
  };
  computerContextEpoch.value += 1;
  delete computerContextEpoch.frameToolCallId;
  delete computerContextEpoch.frameImageIdentity;
  try {
    await compactionPlanState.restore({
      client,
      threadId: thread.threadId,
      timeoutMs: connection.appServer.requestTimeoutMs,
      signal: runAbortController.signal,
    });
  } catch (error) {
    embeddedAgentLog.warn("failed to restore Codex plan state after compaction", {
      runId: params.runId,
      threadId: thread.threadId,
      error: formatErrorMessage(error),
    });
  }
  thread.liveThreadEphemeralPolicy = await restoreCodexThreadSkillsCatalogAfterCompaction({
    client,
    threadId: thread.threadId,
    ephemeralPolicy: thread.liveThreadEphemeralPolicy,
    timeoutMs: connection.appServer.requestTimeoutMs,
    signal: runAbortController.signal,
    assertCurrent,
  });
}
