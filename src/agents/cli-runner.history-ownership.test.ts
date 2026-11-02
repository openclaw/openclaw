import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { MemoryCliSessionHistoryIndex } from "../gateway/cli-session-history-index-memory.js";
import { upsertSessionEntry } from "../plugin-sdk/session-store-runtime.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import type { CliOutput } from "./cli-output-contracts.js";
import { transformCliResultText } from "./cli-output-results.js";
import { runPreparedCliAgent } from "./cli-runner.js";
import { buildPreparedCliRunContext } from "./cli-runner.test-helpers.js";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
// mock-isolation: supply parsed output without spawning a backend.
vi.mock("./cli-runner/execute.runtime.js", () => ({ executePreparedCliRun: execute }));
const dirs = useSessionStoreTempDirs(afterAll, "cli-history-owner-");

it.each([
  { transformed: false, interrupted: false, yielded: false },
  { transformed: true, interrupted: false, yielded: false },
  { transformed: false, interrupted: true, yielded: false },
  { transformed: false, interrupted: false, yielded: true },
])("settles Claude history safely: %j", async ({ transformed, interrupted, yielded }) => {
  const root = dirs.make();
  const target = {
    agentId: "main",
    sessionId: "ownership",
    sessionKey: "agent:main:ownership",
    storePath: path.join(root, "agents/main/agent/openclaw-agent.sqlite"),
  };
  await upsertSessionEntry({
    ...target,
    entry: { sessionId: target.sessionId, updatedAt: Date.now() },
  });
  const replacements = [{ from: "Done", to: "Finished" }];
  const parsed: CliOutput = {
    text: "Checking now\nChecking inputs\nDone",
    rawFinalText: "Done",
    sessionId: "native-session",
    resumeCheckpointId: "final-uuid",
    ...(interrupted ? { terminalInterruption: { reason: "aborted" } } : {}),
    ...(yielded ? { yielded: true } : {}),
  };
  // The process layer applies output replacements before the runner sees the result.
  execute.mockResolvedValue(transformed ? transformCliResultText(parsed, replacements) : parsed);
  const context = buildPreparedCliRunContext({
    sessionTarget: target,
    workspaceDir: root,
    runId: "owner-run",
  });
  Object.assign(context.params, {
    config: {},
    storePath: target.storePath,
    persistAssistantTranscript: true,
    provider: "claude-cli",
  });
  if (transformed) {
    context.backendResolved.textTransforms = { output: replacements };
  }
  await runPreparedCliAgent(context);
  const local = (await loadTranscriptEvents(target)).flatMap((event) =>
    typeof event === "object" && event !== null && "message" in event ? [event.message] : [],
  );
  expect(local).toHaveLength(1);
  if (interrupted || yielded) {
    expect(local[0]).toMatchObject({
      content: [{ type: "text", text: "Checking now\nChecking inputs\nDone" }],
    });
    expect(local[0]).not.toHaveProperty("__openclaw.externalId");
    return;
  }
  // Narration stays in Claude's native rows; the canonical row is the final message.
  expect(local[0]).toMatchObject({
    content: [{ type: "text", text: transformed ? "Finished" : "Done" }],
    __openclaw: {
      importedFrom: "claude-cli",
      cliSessionId: "native-session",
      externalId: "final-uuid",
    },
  });
  const index = new MemoryCliSessionHistoryIndex();
  index.appendLocal(local.map((message, i) => ({ message, seq: i + 1 })));
  // Claude wrote these native rows while the turn ran, before the canonical final committed.
  const startedAt = Date.now() - 10_000;
  for (const [offset, uuid, text] of [
    [0, "progress-uuid", "Checking now"],
    [1, "second-progress-uuid", "Checking inputs"],
    [2, "final-uuid", "Done"],
  ] as const) {
    index.appendImported({
      role: "assistant",
      content: [{ type: "text", text }],
      timestamp: startedAt + offset * 1000,
      __openclaw: {
        importedFrom: "claude-cli",
        cliSessionId: "native-session",
        externalId: uuid,
      },
    });
  }
  index.finish();
  // Each narration and the final answer appear once; the final is the canonical row.
  expect(index.count).toBe(3);
  expect(index.rows(0, 3).map((row) => row.local_seq)).toEqual([null, null, 1]);
  index.close();
});
