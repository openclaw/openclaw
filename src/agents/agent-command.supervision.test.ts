import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { listSupervisedTasks } from "../tasks/supervised-task.store.js";
import type { SupervisedAttemptRunner } from "../tasks/supervised-task.worker.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  agentCommand,
  compactionTestState as state,
  registerAgentCommandCompactionTestHooks,
  makeCompactionResult,
  compactionTestRuntime,
  requireCompactionStorePath,
} from "./agent-command.compaction.test-support.js";
import { deliverAgentCommandResult } from "./command/delivery.js";

const mocks = vi.hoisted(() => ({ classify: vi.fn(), attempt: vi.fn<SupervisedAttemptRunner>() }));
const outbound = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => [{ channel: "slack", messageId: "supervised-status" }]),
);
vi.mock("../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: outbound,
  deliverOutboundPayloadsInternal: outbound,
}));
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
  setActivePluginRegistry(createTestRegistry([]));
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
});

it.each([
  { json: false, sendFails: false },
  { json: true, sendFails: false },
  { json: false, sendFails: true },
  { json: true, sendFails: true },
])(
  "routes supervised delivery and preserves its outcome (json=$json, failure=$sendFails)",
  async ({ json, sendFails }) => {
    const plugin = createOutboundTestPlugin({
      id: "slack",
      outbound: {
        deliveryMode: "direct",
        sendText: async () => ({ channel: "slack", messageId: "fixture" }),
      },
    });
    setActivePluginRegistry(createTestRegistry([{ pluginId: "slack", source: "test", plugin }]));
    state.deliverAgentCommandResultMock.mockImplementation(deliverAgentCommandResult);
    outbound.mockReset().mockResolvedValue([{ channel: "slack", messageId: "supervised-status" }]);
    if (sendFails) {
      outbound.mockRejectedValueOnce(new Error("Synthetic required delivery failure"));
    }
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const pending = agentCommand(
      {
        message: "Repair and report the fixture",
        sessionId: "delivered-supervision",
        sessionKey: "agent:main:explicit:delivered-supervision",
        runId: "delivered-root",
        deliver: true,
        replyChannel: "slack",
        replyTo: "channel:C-SUPERVISED",
        replyAccountId: "repair-account",
        threadId: "thread-42",
        json,
      },
      runtime,
    );
    const result = sendFails
      ? await expect(pending)
          .rejects.toThrow("Synthetic required delivery failure")
          .then(() => undefined)
      : await pending;
    const tasks = listSupervisedTasks();
    expect(tasks).toHaveLength(1);
    const task = tasks[0];
    if (!task) {
      throw new Error("Missing supervised task");
    }
    expect(task.phase).toBe("input_required");
    expect(mocks.attempt).toHaveBeenCalledTimes(1);
    expect(state.runAgentAttemptMock).not.toHaveBeenCalled();
    expect(outbound).toHaveBeenCalledTimes(1);
    expect(outbound).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "slack",
        to: "channel:C-SUPERVISED",
        accountId: "repair-account",
        threadId: "thread-42",
        payloads: [expect.objectContaining({ text: expect.stringContaining(task.flowId) })],
      }),
    );
    if (!sendFails) {
      expect(result).toMatchObject({
        deliverySucceeded: true,
        deliveryStatus: { status: "sent", succeeded: true },
      });
    }
    expect(process.exitCode).toBe(1);
    if (json) {
      expect(runtime.log).toHaveBeenCalledTimes(1);
      const output = runtime.log.mock.calls[0]?.[0];
      if (typeof output !== "string") {
        throw new Error("Missing JSON output");
      }
      expect(JSON.parse(output)).toMatchObject({
        supervisedTask: { phase: "input_required", flowId: task.flowId },
        deliveryStatus: { status: sendFails ? "failed" : "sent" },
      });
    }
  },
);

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
