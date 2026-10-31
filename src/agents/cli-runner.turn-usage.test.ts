/** Tests that a CLI turn's whole-turn usage reaches run metadata, the session row and transcript. */
import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { loadSessionEntry, loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import { upsertSessionEntry } from "../plugin-sdk/session-store-runtime.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { runPreparedCliAgent } from "./cli-runner.js";
import { buildPreparedCliRunContext, requireRecord } from "./cli-runner.test-helpers.js";
import { updateSessionStoreAfterAgentRun } from "./command/session-store.js";

const { executePreparedCliRunMock } = vi.hoisted(() => ({
  executePreparedCliRunMock: vi.fn(),
}));

// mock-isolation: The test supplies parsed CLI output; no backend process may be spawned.
vi.mock("./cli-runner/execute.runtime.js", () => ({
  executePreparedCliRun: executePreparedCliRunMock,
}));

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-cli-turn-usage-");

it("reports and persists the terminal Claude turn usage for a multi-call turn", async () => {
  const root = sessionDirs.make();
  const sessionTarget = {
    agentId: "main",
    sessionId: "cli-turn-usage-session",
    sessionKey: "agent:main:cli-turn-usage",
    storePath: path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite"),
  };
  const seeded: SessionEntry = { sessionId: sessionTarget.sessionId, updatedAt: Date.now() };
  await upsertSessionEntry({ ...sessionTarget, entry: seeded });
  // The Claude stream parser keeps the latest model call apart from the terminal turn total.
  executePreparedCliRunMock.mockResolvedValue({
    text: "done",
    rawText: "done",
    sessionId: "native-session",
    usage: { input: 2, output: 1, cacheRead: 27_376 },
    diagnosticUsage: { input: 6, output: 77, cacheRead: 54_631 },
  });
  const context = buildPreparedCliRunContext({
    sessionTarget,
    workspaceDir: root,
    runId: "run-claude-turn-usage",
  });
  Object.assign(context.params, {
    config: {},
    storePath: sessionTarget.storePath,
    persistAssistantTranscript: true,
  });

  const result = await runPreparedCliAgent(context);

  // Live context metadata stays on the latest model call; billing usage spans the turn.
  expect(result.meta.agentMeta?.lastCallUsage).toMatchObject({ output: 1, cacheRead: 27_376 });
  expect(result.meta.agentMeta?.usage).toEqual({
    input: 6,
    output: 77,
    cacheRead: 54_631,
    contextUsage: { state: "unavailable" },
  });
  await updateSessionStoreAfterAgentRun({
    cfg: {},
    agentId: "main",
    agentDir: path.join(root, "agent-dir"),
    sessionId: sessionTarget.sessionId,
    sessionKey: sessionTarget.sessionKey,
    storePath: sessionTarget.storePath,
    sessionStore: { [sessionTarget.sessionKey]: seeded },
    defaultProvider: "claude-cli",
    defaultModel: "claude-sonnet-5",
    result,
  });
  expect(loadSessionEntry(sessionTarget)).toMatchObject({
    inputTokens: 6,
    outputTokens: 77,
    totalTokens: 27_378,
  });
  const messages = (await loadTranscriptEvents(sessionTarget)).flatMap((event) =>
    typeof event === "object" && event !== null && "message" in event ? [event.message] : [],
  );
  expect(messages).toHaveLength(1);
  // Transcript counters account for the whole turn; the context marker keeps the last call.
  expect(requireRecord(messages[0], "assistant message").usage).toEqual({
    input: 6,
    output: 77,
    cacheRead: 54_631,
    cacheWrite: 0,
    totalTokens: 54_714,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    contextUsage: { state: "available", promptTokens: 27_378, totalTokens: 27_379 },
  });
});
