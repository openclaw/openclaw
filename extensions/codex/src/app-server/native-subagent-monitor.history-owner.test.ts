import { createAgentHarnessTaskRuntime } from "openclaw/plugin-sdk/agent-harness-task-runtime";
import { createAdmittedHostCapabilityTestFixture } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import {
  ensureCodexAppServerClientRuntime,
  isCodexAppServerLiveThreadClaimed,
} from "./client-runtime.js";
import { createFakeCodexAppServerClient } from "./codex-app-server.test-fixtures.js";
import type { CodexNativeSubagentHistoryOwner } from "./native-subagent-history-owner.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import { threadRead } from "./native-subagent-monitor.test-support.js";

const original: CodexNativeSubagentHistoryOwner = {
  parentThreadId: "original-parent",
  sessionId: "original-session",
  lifecycleRevision: "same-lifecycle",
  connectionFingerprint: "a".repeat(64),
};
const current = { ...original, parentThreadId: "current-parent" };
const unstampedLifecycle = { ...original, lifecycleRevision: undefined };
const cases: Array<{
  name: string;
  stored: CodexNativeSubagentHistoryOwner | undefined;
  current: CodexNativeSubagentHistoryOwner | undefined;
  allow: boolean;
  allowInspection?: boolean;
  terminal?: boolean;
}> = [
  { name: "native parent rotation", stored: original, current, allow: true },
  {
    name: "physical replacement within explicit lifecycle",
    stored: original,
    current: { ...current, sessionId: "adopted-session" },
    allow: false,
    allowInspection: true,
  },
  {
    name: "in-place reset preserving session id",
    stored: original,
    current: { ...current, lifecycleRevision: "next-lifecycle" },
    allow: false,
  },
  {
    name: "fresh session without lifecycle revision",
    stored: unstampedLifecycle,
    current: { ...current, sessionId: "fresh-session", lifecycleRevision: undefined },
    allow: false,
  },
  {
    name: "first reset of a legacy lifecycle stamp",
    stored: unstampedLifecycle,
    current: { ...current, lifecycleRevision: "first-reset" },
    allow: false,
  },
  {
    name: "connection replacement",
    stored: original,
    current: { ...current, connectionFingerprint: "b".repeat(64) },
    allow: false,
  },
  {
    name: "unstamped task under unchanged native parent",
    stored: undefined,
    current: original,
    allow: false,
  },
  { name: "unstamped task after native parent rotation", stored: undefined, current, allow: false },
  {
    name: "stamped task without current history authority",
    stored: original,
    current: undefined,
    allow: false,
  },
  {
    name: "unstamped task without current history authority",
    stored: undefined,
    current: undefined,
    allow: false,
  },
  {
    name: "pending terminal completion after native parent rotation",
    stored: original,
    current,
    allow: true,
    terminal: true,
  },
  {
    name: "pending terminal completion after physical replacement",
    stored: original,
    current: { ...current, sessionId: "adopted-session" },
    allow: false,
    allowInspection: true,
    terminal: true,
  },
  {
    name: "unstamped pending terminal completion under unchanged native parent",
    stored: undefined,
    current: original,
    allow: false,
    terminal: true,
  },
];

describe("automatic native task history ownership", () => {
  it.each(cases)("scopes recovery for $name", async (scenario) => {
    const { name, stored, current: owner, allow, allowInspection, terminal } = scenario;
    await withStateDirEnv("codex-history-owner-", async ({ stateDir }) => {
      const requesterSessionKey = "agent:main:history-owner";
      const host = await createAdmittedHostCapabilityTestFixture({
        runId: `history-owner-${name}`,
        agentId: "main",
        sessionKey: requesterSessionKey,
        config: {},
      });
      const scope = host.agentHarnessTaskRuntimeScope;
      if (!scope) {
        throw new Error("task runtime scope missing");
      }
      const tasks = createAgentHarnessTaskRuntime({
        runtime: "subagent",
        taskKind: "codex-native",
        scope,
        runIdPrefix: "codex-thread:",
      });
      const runId = "codex-thread:history-child";
      let originalTask = tasks.createRunningTaskRun({
        runId,
        sourceId: runId,
        task: "recover the original native result",
        notifyPolicy: "silent",
        deliveryStatus: "not_applicable",
        detail: { nativeTurnId: "original-turn", ...(stored ? { nativeHistory: stored } : {}) },
      });
      if (terminal) {
        tasks.finalizeTaskRunByRunId({
          runId,
          status: "succeeded",
          endedAt: Date.now(),
          terminalSummary: "original native result",
        });
        tasks.setDetachedTaskDeliveryStatusByRunId({ runId, deliveryStatus: "pending" });
        originalTask = tasks.listTaskRecords()[0]!;
      }
      const fixture = createFakeCodexAppServerClient(async (method) => {
        if (method !== "thread/read") {
          throw new Error(`Unexpected native request: ${method}`);
        }
        return threadRead({
          childThreadId: "history-child",
          parentThreadId: original.parentThreadId,
          turnId: "original-turn",
          result: "original native result",
          completedAt: Math.floor(Date.now() / 1000),
        });
      });
      const { client } = fixture;
      ensureCodexAppServerClientRuntime(client, { agentDir: stateDir });
      const deliver = vi.fn(async () => ({ delivered: true, path: "direct" as const }));
      const parent = codexNativeSubagentMonitorRuntime.register({
        client,
        parentThreadId: owner?.parentThreadId ?? "current-parent",
        requesterSessionKey,
        taskRuntimeScope: scope,
        agentId: "main",
        ...(owner ? { historyOwner: owner } : {}),
        runtime: { createAgentHarnessTaskRuntime, deliverAgentHarnessTaskCompletion: deliver },
      });
      try {
        await parent.unregister();
        if (allow) {
          await vi.waitFor(() =>
            expect(tasks.listTaskRecords()[0]).toMatchObject({
              status: "succeeded",
              deliveryStatus: "delivered",
              terminalSummary: "original native result",
            }),
          );
          expect(deliver).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ result: "original native result" }),
          );
        } else {
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(deliver).not.toHaveBeenCalled();
          expect(tasks.listTaskRecords()[0]).toEqual(originalTask);
        }
        expect(tasks.listTaskRecords()[0]?.detail).toEqual(originalTask.detail);
        if (stored && !allow) {
          expect(fixture.request).toHaveBeenCalledTimes(allowInspection ? 1 : 0);
        }
      } finally {
        await parent.unregister();
        fixture.close();
        host.closeHost();
        host.closeAdmission();
      }
    });
  });
});

it.each([
  {
    retireReplacement: false,
    releaseReplacement: false,
    reregisterReplacement: false,
    label: "keeps delivery while the replacement lifecycle is active",
  },
  {
    retireReplacement: true,
    releaseReplacement: false,
    reregisterReplacement: false,
    label: "cancels recovered work when the replacement parent retires",
  },
  {
    retireReplacement: true,
    releaseReplacement: true,
    reregisterReplacement: false,
    label: "cancels recovered work after its replacement registration was released",
  },
  {
    retireReplacement: true,
    releaseReplacement: true,
    reregisterReplacement: true,
    label: "cancels recovered work during same-lifecycle replacement re-registration",
  },
])("$label", async ({ retireReplacement, releaseReplacement, reregisterReplacement }) => {
  await withStateDirEnv("codex-recovered-parent-retirement-", async ({ stateDir }) => {
    const requesterSessionKey = `agent:main:recovered-parent-retirement-${retireReplacement}-${releaseReplacement}`;
    const originalParent = "native-original-parent";
    const currentParent = "native-replacement-parent";
    const childThreadId = "recovered-child";
    const childTurnId = "recovered-child-turn";
    const runId = `codex-thread:${childThreadId}`;
    const host = await createAdmittedHostCapabilityTestFixture({
      runId: "retirement-control",
      agentId: "main",
      sessionKey: requesterSessionKey,
      config: {},
    });
    const taskRuntimeScope = host.agentHarnessTaskRuntimeScope;
    if (!taskRuntimeScope) {
      throw new Error("Task runtime scope missing");
    }
    const taskRuntime = createAgentHarnessTaskRuntime({
      scope: taskRuntimeScope,
      runtime: "subagent",
      taskKind: "codex-native",
      runIdPrefix: "codex-thread:",
    });
    const originalHistory = {
      ...original,
      parentThreadId: originalParent,
    };
    taskRuntime.createRunningTaskRun({
      sourceId: runId,
      runId,
      agentId: "main",
      task: "Complete work started under the original native parent.",
      notifyPolicy: "silent",
      deliveryStatus: "not_applicable",
      detail: { nativeHistory: originalHistory, nativeTurnId: childTurnId },
    });
    const readTask = () => taskRuntime.listTaskRecords().find((task) => task.runId === runId);
    const fixture = createFakeCodexAppServerClient(async (method) => {
      if (method === "thread/unsubscribe") {
        return {};
      }
      if (method !== "thread/read") {
        throw new Error(`Unexpected native request: ${method}`);
      }
      return threadRead({
        childThreadId,
        parentThreadId: originalParent,
        turnId: childTurnId,
        status: "inProgress",
        threadStatus: "active",
      });
    });
    const { client } = fixture;
    ensureCodexAppServerClientRuntime(client, { agentDir: stateDir });
    const deliver = vi.fn(async () => ({ delivered: true, path: "direct" as const }));
    const registration = {
      client,
      parentThreadId: currentParent,
      requesterSessionKey,
      agentId: "main",
      taskRuntimeScope,
      historyOwner: { ...originalHistory, parentThreadId: currentParent },
      runtime: { createAgentHarnessTaskRuntime, deliverAgentHarnessTaskCompletion: deliver },
    };
    let replacement = codexNativeSubagentMonitorRuntime.register(registration);
    replacement.bindTurn("replacement-parent-turn");
    try {
      // Wait for actual recovered native custody, not just a scheduled history request.
      await vi.waitFor(() =>
        expect(isCodexAppServerLiveThreadClaimed(client, childThreadId)).toBe(true),
      );
      expect(readTask()).toMatchObject({ status: "running", deliveryStatus: "not_applicable" });
      expect(
        taskRuntime.listTaskRecords().find((task) => task.runId === runId)?.detail,
      ).toMatchObject({
        nativeHistory: originalHistory,
      });
      expect(deliver).not.toHaveBeenCalled();

      if (releaseReplacement) {
        await replacement.unregister();
      }
      if (reregisterReplacement) {
        replacement = codexNativeSubagentMonitorRuntime.register(registration);
      }
      if (retireReplacement) {
        codexNativeSubagentMonitorRuntime.retireParent(client, currentParent);
      }
      const afterRetirement = readTask();
      await fixture.notify({
        method: "turn/completed",
        params: {
          threadId: childThreadId,
          turn: {
            id: childTurnId,
            status: "completed",
            error: null,
            items: [
              {
                id: "late-old-parent-result",
                type: "agentMessage",
                phase: "final_answer",
                text: "The old native child finished.",
              },
            ],
          },
        },
      });
      await vi.waitFor(() =>
        expect(isCodexAppServerLiveThreadClaimed(client, childThreadId)).toBe(false),
      );

      if (retireReplacement) {
        expect(deliver).not.toHaveBeenCalled();
        expect(afterRetirement).toMatchObject({
          status: "cancelled",
          deliveryStatus: "not_applicable",
          terminalSummary: "Subagent parent session ended.",
        });
        expect(readTask()).toEqual(afterRetirement);
      } else {
        expect(deliver).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            childSessionKey: runId,
            childSessionId: childThreadId,
            status: "succeeded",
            result: "The old native child finished.",
          }),
        );
        expect(readTask()).toMatchObject({
          status: "succeeded",
          deliveryStatus: "delivered",
          terminalSummary: "The old native child finished.",
        });
      }
    } finally {
      codexNativeSubagentMonitorRuntime.retireParent(client, currentParent);
      codexNativeSubagentMonitorRuntime.retireParent(client, originalParent);
      await replacement.unregister();
      fixture.close();
      host.closeHost();
      host.closeAdmission();
    }
  });
});
