import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import {
  setRuntimeConfigSnapshot,
  clearRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { MemoryCliSessionHistoryIndex } from "../gateway/cli-session-history-index-memory.js";
import { upsertSessionEntry } from "../plugin-sdk/session-store-runtime.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import type { CliOutput } from "./cli-output-contracts.js";
import { transformCliResultText } from "./cli-output-results.js";
import { createClaudeParser, joinJsonlFrames } from "./cli-output.test-helpers.js";
import { runPreparedCliAgent } from "./cli-runner.js";
import { buildPreparedCliRunContext } from "./cli-runner.test-helpers.js";
import { loadCliSessionHistoryMessages } from "./cli-runner/session-history.js";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
// mock-isolation: supply parsed output without spawning a backend.
vi.mock("./cli-runner/execute.runtime.js", () => ({ executePreparedCliRun: execute }));
const dirs = useSessionStoreTempDirs(afterAll, "cli-history-owner-");
afterAll(clearRuntimeConfigSnapshot);

// Completed held answers are not narration: canonical consumers need both results.
it.each([false, true])(
  "retains held answers in canonical history (transformed=%s)",
  async (transformed) => {
    setRuntimeConfigSnapshot({});
    const root = dirs.make();
    const target = {
      agentId: "main",
      sessionId: "held-answer",
      sessionKey: "agent:main:held-answer",
      storePath: path.join(root, "agents/main/agent/openclaw-agent.sqlite"),
    };
    await upsertSessionEntry({
      ...target,
      entry: { sessionId: target.sessionId, updatedAt: Date.now() },
    });
    const parser = createClaudeParser();
    for (const [index, text] of ["PARENT_COMPLETE", "CHILD_COMPLETE"].entries()) {
      parser.push(
        joinJsonlFrames(
          { type: "system", subtype: "init", session_id: "native-held" },
          {
            type: "assistant",
            uuid: "answer-" + index,
            message: { role: "assistant", content: [{ type: "text", text }] },
          },
          {
            type: "result",
            subtype: "success",
            result: text,
            session_id: "native-held",
            ...(index === 0 ? { openclaw_interim_result: true } : {}),
          },
          "",
        ),
      );
    }
    parser.finish();
    expect(parser.getOutput()).toMatchObject({
      textParts: ["PARENT_COMPLETE", "CHILD_COMPLETE"],
      rawFinalText: "CHILD_COMPLETE",
      resumeCheckpointId: "answer-1",
    });
    const replacements = [{ from: "COMPLETE", to: "DONE" }];
    const output = parser.getOutput();
    if (!output) {
      throw new Error("Expected completed CLI output");
    }
    execute.mockResolvedValue(transformed ? transformCliResultText(output, replacements) : output);
    const context = buildPreparedCliRunContext({
      sessionTarget: target,
      workspaceDir: root,
      runId: "held-answer-run",
    });
    Object.assign(context.params, {
      config: {},
      storePath: target.storePath,
      persistAssistantTranscript: true,
    });
    if (transformed) {
      context.backendResolved.textTransforms = { output: replacements };
    }
    const result = await runPreparedCliAgent(context);
    const texts = transformed
      ? ["PARENT_DONE", "CHILD_DONE"]
      : ["PARENT_COMPLETE", "CHILD_COMPLETE"];
    expect(result.payloads?.map((payload) => payload.text)).toEqual(texts);
    const history = await loadCliSessionHistoryMessages({ sessionTarget: target });
    expect(history).toHaveLength(2);
    for (const [i, text] of texts.entries()) {
      expect(history[i]).toMatchObject({
        content: [{ type: "text", text }],
        __openclaw: {
          importedFrom: "claude-cli",
          cliSessionId: "native-held",
          externalId: `answer-${i}`,
        },
      });
    }
    const index = new MemoryCliSessionHistoryIndex();
    index.appendLocal(history.map((message, i) => ({ message, seq: i + 1 })));
    for (const [i, text] of ["PARENT_COMPLETE", "CHILD_COMPLETE"].entries()) {
      index.appendImported({
        role: "assistant",
        content: [{ type: "text", text }],
        timestamp: Date.now() - 10_000 + i,
        __openclaw: {
          importedFrom: "claude-cli",
          cliSessionId: "native-held",
          externalId: `answer-${i}`,
        },
      });
    }
    index.finish();
    expect(index.count).toBe(2);
    expect(index.rows(0, 2).map((row) => row.local_seq)).toEqual([1, 2]);
    index.close();
  },
);

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
