import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { openOpenClawAgentDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { configureMemoryCoreDreamingStateForTests } from "./test-helpers.js";

export async function createMemoryForgetFixture(prefix = "openclaw-memory-forget-") {
  const state = await createOpenClawTestState({ prefix, layout: "state-only" });
  const { stateDir, workspaceDir } = state;
  await configureMemoryCoreDreamingStateForTests();
  const cfg: OpenClawConfig = {
    agents: { defaults: { workspace: workspaceDir }, list: [{ id: "main", default: true }] },
  };
  return {
    stateDir,
    workspaceDir,
    cfg,
    cleanup: async () => {
      await state.restoreEnv();
      resetPluginStateStoreForTests();
      await state.cleanup();
    },
  };
}

export async function seedMemoryForgetSession(
  sessionId: string,
  hookSource?: "gmail" | "webhook",
): Promise<void> {
  const sessionKey = `agent:main:${sessionId}`;
  await upsertSessionEntry({
    agentId: "main",
    sessionKey,
    entry: { sessionId, updatedAt: 1_000 },
  });
  if (hookSource) {
    openOpenClawAgentDatabase({ agentId: "main" })
      .db.prepare(
        "UPDATE session_windows SET hook_external_content_source = ? WHERE session_id = ?",
      )
      .run(hookSource, sessionId);
  }
}
