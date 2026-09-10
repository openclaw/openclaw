import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { listSupervisedTasks } from "../tasks/supervised-task.store.js";
import type { SupervisedAttemptRunner } from "../tasks/supervised-task.worker.js";
import {
  agentCommand,
  compactionTestState as state,
  registerAgentCommandCompactionTestHooks,
  makeCompactionResult,
  compactionTestRuntime,
  requireCompactionStorePath,
} from "./agent-command.compaction.test-support.js";

const mocks = vi.hoisted(() => ({ classify: vi.fn(), attempt: vi.fn<SupervisedAttemptRunner>() }));
vi.mock("./isolated-completion.js", () => ({ runIsolatedCompletion: mocks.classify }));
vi.mock("./harness/policy.js", () => ({
  resolveAgentHarnessPolicy: () => ({ runtime: "codex", runtimeSource: "model" }),
}));
vi.mock("../tasks/supervised-task.agent.js", () => ({
  prepareSupervisedAgentRuntime: async () => {},
  runSupervisedAgentAttempt: mocks.attempt,
}));
registerAgentCommandCompactionTestHooks();
beforeEach(async () => {
  if (!state.cfg || !state.workspaceDir) {
    throw new Error("Missing source fixture");
  }
  const policyFile = path.join(state.workspaceDir, "policy.json");
  const input = path.join(state.workspaceDir, "input");
  await fs.mkdir(input);
  await fs.writeFile(
    policyFile,
    JSON.stringify({
      version: 1,
      scope: "Repair fixture",
      goal: {
        objective: "Repair fixture",
        success: [{ id: "correct", description: "Operator reviewed" }],
        partial: [],
      },
      workflow: {
        version: 1,
        workspace: input,
        profiles: [],
        acceptance: [{ kind: "operator", criterionId: "correct" }],
      },
      maxAttempts: 3,
      attemptTimeoutMs: 10000,
      episodeTimeoutMs: 60000,
    }),
    { mode: 0o600 },
  );
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(state.workspaceDir, "state"));
  state.cfg.agents = {
    ...state.cfg.agents,
    entries: { main: { taskSupervision: { enabled: true, policyFile } } },
  };
  mocks.classify
    .mockReset()
    .mockResolvedValue({ text: '{"kind":"task"}', owner: { kind: "harness", id: "codex" } });
  mocks.attempt.mockReset().mockResolvedValue({
    kind: "input_required",
    reason: "Need expected behavior",
    question: "Which behavior should be retained?",
  });
});
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
});

it("automatically admits an operator's local command and waits for its real stored endpoint", async () => {
  const sessionId = "local-supervised";
  const sessionKey = `agent:main:explicit:${sessionId}`;
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  const result = await agentCommand(
    { message: "Repair the fixture", sessionId, sessionKey, runId: "local-root-run", json: true },
    runtime,
  );
  expect(mocks.classify).toHaveBeenCalledTimes(1);
  expect(mocks.attempt).toHaveBeenCalledTimes(1);
  expect(state.runAgentAttemptMock).not.toHaveBeenCalled();
  const tasks = listSupervisedTasks();
  expect(tasks).toHaveLength(1);
  expect(tasks[0]).toMatchObject({
    phase: "input_required",
    attempts: 1,
    prompt: "Repair the fixture",
  });
  expect(result).toMatchObject({
    payloads: [{ text: expect.stringContaining("input_required"), mediaUrl: null }],
  });
  expect(process.exitCode).toBe(1);
  const entry = compactionTestRuntime.loadSessionEntry({
    storePath: requireCompactionStorePath(),
    sessionKey,
  });
  expect(entry?.restartRecoveryDeliveryRunId).toBeUndefined();
});

it("preserves ordinary local execution and does not classify internal runtime turns", async () => {
  mocks.classify.mockResolvedValue({
    text: '{"kind":"ordinary"}',
    owner: { kind: "harness", id: "codex" },
  });
  state.runAgentAttemptMock.mockImplementation(async () =>
    makeCompactionResult({
      sessionId: "ordinary",
      text: "Ordinary answer",
      runner: "embedded",
      agentHarnessId: "openclaw",
    }),
  );
  await agentCommand(
    {
      message: "Explain this concept",
      sessionId: "ordinary",
      sessionKey: "agent:main:explicit:ordinary",
      runId: "ordinary-run",
    },
    { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
  );
  expect(mocks.classify).toHaveBeenCalledTimes(1);
  expect(state.runAgentAttemptMock).toHaveBeenCalledTimes(1);
  const { agentCommandFromSystem } = await import("./agent-command.js");
  await agentCommandFromSystem(
    {
      message: "Internal step",
      sessionId: "system",
      sessionKey: "agent:main:explicit:system",
      runId: "system-run",
    },
    { boundary: "supervision-fixture" },
    { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
  );
  expect(mocks.classify).toHaveBeenCalledTimes(1);
  expect(state.runAgentAttemptMock).toHaveBeenCalledTimes(2);
  expect(mocks.attempt).not.toHaveBeenCalled();
  expect(listSupervisedTasks()).toEqual([]);
});
