// Live proof for Codex native subagent monitoring against a real app-server:
// spawned-child lineage, detached completion delivery, and history recovery.
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type {
  AgentHarnessScopedCreateRunningTaskRunParams,
  AgentHarnessScopedFinalizeTaskRunParams,
  AgentHarnessScopedSetDeliveryStatusParams,
  AgentHarnessTaskRecord,
  AgentHarnessTaskRuntimeScope,
} from "openclaw/plugin-sdk/agent-harness-task-runtime";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import { setManagedCodexPluginRoot } from "./managed-binary.js";
import { createCodexNativeSubagentHistoryOwner } from "./native-subagent-history-owner.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import { codexNativeSubagentNotifications } from "./native-subagent-notification.js";
import { buildCodexAppServerRuntimeFingerprint } from "./plugin-app-cache-key.js";
import type { JsonObject } from "./protocol.js";
import { isJsonObject } from "./protocol.js";
import { createIsolatedCodexAppServerClient } from "./shared-client.js";

const CodexNativeSubagentMonitor = codexNativeSubagentMonitorRuntime.Monitor;

const LIVE =
  process.env.OPENCLAW_LIVE_TEST === "1" && process.env.OPENCLAW_LIVE_CODEX_NATIVE_SUBAGENT === "1";
const describeLive = LIVE ? describe : describe.skip;

type RecordedDelivery = {
  childSessionId: string;
  status: string;
  result: string;
};

function traceNativeLive(phase: string, detail: JsonObject = {}): void {
  console.info("[codex-native-live]", JSON.stringify({ at: Date.now(), phase, ...detail }));
}

function createDeliveryRecorder(
  taskRecords: AgentHarnessTaskRecord[] = [],
  requesterSessionKey = "live:streamed",
) {
  const deliveries: RecordedDelivery[] = [];
  const taskRuntime = {
    tryCreateRunningTaskRun: (params: AgentHarnessScopedCreateRunningTaskRunParams) => {
      const existing = taskRecords.find((task) => task.runId === params.runId);
      if (existing) {
        if (params.detail !== undefined) {
          existing.detail = params.detail;
        }
        return existing;
      }
      const task: AgentHarnessTaskRecord = {
        taskId: params.runId,
        runtime: "subagent",
        taskKind: "codex-native",
        scopeKind: "session",
        ownerKey: requesterSessionKey,
        requesterSessionKey,
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: Date.now(),
        runId: params.runId,
        task: params.task,
        ...(params.detail === undefined ? {} : { detail: params.detail }),
      };
      taskRecords.push(task);
      traceNativeLive("task-created", {
        runId: task.runId ?? null,
        requesterSessionKey,
        hasHistoryOwner: isJsonObject(task.detail) && isJsonObject(task.detail.nativeHistory),
      });
      return task;
    },
    recordTaskRunProgressByRunId: () => [],
    finalizeTaskRunByRunId: (params: AgentHarnessScopedFinalizeTaskRunParams) => {
      const task = taskRecords.find((record) => record.runId === params.runId);
      if (!task) {
        return [];
      }
      task.status = params.status;
      task.endedAt = params.endedAt;
      task.terminalSummary = params.terminalSummary ?? undefined;
      if (params.detail !== undefined) {
        task.detail = params.detail;
      }
      traceNativeLive("task-finalized", { runId: params.runId, status: params.status });
      return [task];
    },
    listTaskRecords: () => taskRecords,
    setDetachedTaskDeliveryStatusByRunId: (params: AgentHarnessScopedSetDeliveryStatusParams) => {
      const task = taskRecords.find((record) => record.runId === params.runId);
      if (!task) {
        return [];
      }
      const previous = task.deliveryStatus;
      Object.assign(task, params);
      if (task.deliveryStatus !== previous) {
        traceNativeLive("task-delivery-state", {
          runId: params.runId,
          previous,
          deliveryStatus: task.deliveryStatus,
        });
      }
      return [task];
    },
  };
  return {
    deliveries,
    records: taskRecords,
    runtime: {
      captureAgentHarnessCompletionCustody: () => undefined,
      createAgentHarnessTaskEventSink: () => () => {},
      createAgentHarnessTaskRuntime: () => taskRuntime,
      deliverAgentHarnessTaskCompletion: async (params: RecordedDelivery) => {
        traceNativeLive("delivery-callback", {
          childThreadId: params.childSessionId,
          status: params.status,
          resultChars: params.result.length,
        });
        deliveries.push({
          childSessionId: params.childSessionId,
          status: params.status,
          result: params.result,
        });
        return { delivered: true, path: "steered" as const };
      },
    } as never,
  };
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  traceNativeLive("wait-start", { what });
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== undefined) {
      traceNativeLive("wait-complete", { what });
      return value;
    }
    await delay(500);
  }
  traceNativeLive("wait-timeout", { what });
  throw new Error(`timed out waiting for ${what}`);
}

describeLive("codex native subagent monitor live", () => {
  beforeEach(() => {
    setManagedCodexPluginRoot(fileURLToPath(new URL("../../", import.meta.url)));
  });
  afterEach(() => {
    setManagedCodexPluginRoot(undefined);
  });

  it("runs native shell work again on a completed child and keeps all three results", async () => {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is required for this live test");
    }
    await withTempDir("openclaw-codex-native-followup-", async (root) => {
      const workspace = path.join(root, "workspace");
      await fs.mkdir(workspace, { recursive: true });
      const options = resolveCodexAppServerRuntimeOptions({
        pluginConfig: { appServer: { homeScope: "user" } },
        env: {},
      });
      const client = await createIsolatedCodexAppServerClient({
        startOptions: {
          ...options.start,
          env: { CODEX_HOME: path.join(root, "codex-home") },
          clearEnv: ["CODEX_API_KEY", "OPENAI_API_KEY"],
        },
        agentDir: path.join(root, "agent"),
        authProfileId: null,
        timeoutMs: 120_000,
      });
      try {
        await client.request(
          "account/login/start",
          { type: "apiKey", apiKey },
          { timeoutMs: 60_000 },
        );
        const started = await client.request(
          "thread/start",
          {
            model: "gpt-5.5",
            cwd: workspace,
            approvalPolicy: "never",
            sandbox: "read-only",
            threadSource: "user",
            experimentalRawEvents: true,
            config: { "features.multi_agent": true },
          },
          { timeoutMs: 120_000 },
        );
        const parentThreadId = started.thread.id;
        const completedTurns = new Set<string>();
        const shellResults: Array<{ threadId: string; output: string }> = [];
        client.addNotificationHandler((notification) => {
          const params = isJsonObject(notification.params) ? notification.params : undefined;
          if (
            notification.method === "turn/completed" &&
            params?.threadId === parentThreadId &&
            isJsonObject(params.turn) &&
            typeof params.turn.id === "string"
          ) {
            completedTurns.add(params.turn.id);
          }
          const item = isJsonObject(params?.item) ? params.item : undefined;
          if (
            notification.method === "item/completed" &&
            params?.threadId !== parentThreadId &&
            typeof params?.threadId === "string" &&
            item?.type === "commandExecution" &&
            item.exitCode === 0 &&
            typeof item.aggregatedOutput === "string"
          ) {
            shellResults.push({ threadId: params.threadId, output: item.aggregatedOutput });
          }
        });
        const tasks: AgentHarnessTaskRecord[] = [];
        const recorder = createDeliveryRecorder(tasks, "live:followup");
        const monitor = new CodexNativeSubagentMonitor(client as never, recorder.runtime);
        const claims = { first: 0, second: 0, third: 0 };
        const releases = { first: 0, second: 0, third: 0 };
        const registerParent = (owner: "first" | "second" | "third") =>
          monitor.registerParent({
            parentThreadId,
            requesterSessionKey: "live:followup",
            taskRuntimeScope: {
              requesterSessionKey: "live:followup",
            } as AgentHarnessTaskRuntimeScope,
            agentId: "live",
            historyOwner: {
              parentThreadId,
              sessionId: "live-parent-session",
              connectionFingerprint: "a".repeat(64),
            },
            claimDirectChild: () => {
              claims[owner] += 1;
              return () => {
                releases[owner] += 1;
              };
            },
          });
        let parent = registerParent("first");
        const run = async (text: string) => {
          const turn = await client.request(
            "turn/start",
            {
              threadId: parentThreadId,
              input: [{ type: "text", text, text_elements: [] }],
            },
            { timeoutMs: 300_000 },
          );
          parent.bindTurn(turn.turn.id);
          await waitFor(
            () => (completedTurns.has(turn.turn.id) ? true : undefined),
            300_000,
            "parent completion",
          );
        };
        await run(
          "Spawn exactly one native subagent. Tell it to run the shell command printf FIRST_NATIVE_SHELL, then reply exactly FIRST_RESULT. Wait for that child to finish using native collaboration. Keep the child open for a later follow-up. Reply PARENT_FIRST when done.",
        );
        await waitFor(
          () => (tasks[0]?.status === "succeeded" ? true : undefined),
          60_000,
          "first child result",
        );
        expect(tasks).toHaveLength(1);
        expect(tasks[0]?.terminalSummary).toBe("FIRST_RESULT");
        await waitFor(
          () => (tasks[0]?.deliveryStatus === "delivered" ? true : undefined),
          60_000,
          "first native receipt",
        );
        const first = structuredClone(tasks[0]!);
        const childThreadId = first.runId!.slice("codex-thread:".length);
        expect(shellResults).toContainEqual({
          threadId: childThreadId,
          output: "FIRST_NATIVE_SHELL",
        });
        await parent.unregister();
        expect(claims.first).toBe(1);
        expect(releases.first).toBe(1);
        const expectedTasks = [first];
        for (const ordinal of ["second", "third"] as const) {
          const token = ordinal.toUpperCase();
          parent = registerParent(ordinal);
          await run(
            `Send a follow-up to that same completed child using native collaboration; do not spawn another child. Tell it to run the shell command printf ${token}_NATIVE_SHELL, then reply exactly ${token}_RESULT. Wait for its result, keep the child open for another follow-up, then reply PARENT_${token}.`,
          );
          const assignment = await waitFor(
            () =>
              tasks.find(
                (task) => task.terminalSummary === `${token}_RESULT` && task.status === "succeeded",
              ),
            60_000,
            `${ordinal} child result`,
          );
          expect(tasks).toHaveLength(expectedTasks.length + 1);
          for (const previous of expectedTasks) {
            expect(tasks.find((task) => task.runId === previous.runId)).toEqual(previous);
          }
          expect(assignment.runId).toMatch(new RegExp(`^codex-thread:${childThreadId}:turn:`));
          expect(expectedTasks.map((task) => task.runId)).not.toContain(assignment.runId);
          expect(shellResults).toContainEqual({
            threadId: childThreadId,
            output: `${token}_NATIVE_SHELL`,
          });
          await waitFor(
            () => (assignment.deliveryStatus === "delivered" ? true : undefined),
            60_000,
            `${ordinal} native receipt`,
          );
          expectedTasks.push(structuredClone(assignment));
          await parent.unregister();
        }
        expect(claims).toEqual({ first: 1, second: 1, third: 1 });
        expect(releases).toEqual({ first: 1, second: 1, third: 1 });
        expect(recorder.deliveries).toEqual([]);
        monitor.dispose();
      } finally {
        await client.closeAndWait();
      }
    });
  }, 900_000);

  it("delivers spawned subagent results live and recovers them from history", async () => {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is required for this live test");
    }
    await withTempDir("openclaw-codex-native-subagent-", async (root) => {
      traceNativeLive("detached-scenario-start");
      let client: CodexAppServerClient | undefined;
      try {
        const codexHome = path.join(root, "codex-home");
        const workspace = path.join(root, "workspace");
        await fs.mkdir(workspace, { recursive: true });
        const runtime = resolveCodexAppServerRuntimeOptions({
          pluginConfig: { appServer: { homeScope: "user" } },
          env: {},
        });
        const startOptions = {
          ...runtime.start,
          env: { CODEX_HOME: codexHome },
          clearEnv: ["CODEX_API_KEY", "OPENAI_API_KEY"],
        };
        client = await createIsolatedCodexAppServerClient({
          startOptions,
          agentDir: path.join(root, "agent"),
          authProfileId: null,
          timeoutMs: 120_000,
        });
        traceNativeLive("app-server-ready");
        await client.request(
          "account/login/start",
          { type: "apiKey", apiKey },
          { timeoutMs: 60_000 },
        );
        traceNativeLive("login-complete");

        let parentThreadId = "";
        let parentTurnCompleted = false;
        const waitCalls = new Set<string>();
        client.addNotificationHandler((notification) => {
          const params = isJsonObject(notification.params) ? notification.params : undefined;
          const item = isJsonObject(params?.item) ? params.item : undefined;
          const turn = isJsonObject(params?.turn) ? params.turn : undefined;
          const isWait = item?.type === "collabAgentToolCall" && item.tool === "wait";
          if (isWait && typeof item.id === "string") {
            waitCalls.add(item.id);
          }
          const isWaitOutput =
            item?.type === "function_call_output" &&
            typeof item.call_id === "string" &&
            waitCalls.has(item.call_id);
          const receipts = codexNativeSubagentNotifications.deliveredAgentPaths(notification);
          if (
            notification.method === "turn/started" ||
            notification.method === "turn/completed" ||
            notification.method === "rawResponse/completed" ||
            item?.type === "contextCompaction" ||
            isWait ||
            isWaitOutput ||
            receipts.length > 0
          ) {
            traceNativeLive("native-event", {
              method: notification.method,
              threadId: typeof params?.threadId === "string" ? params.threadId : null,
              turnId: typeof params?.turnId === "string" ? params.turnId : (turn?.id ?? null),
              turnStatus: turn?.status ?? null,
              itemType: item?.type ?? null,
              itemId: item?.id ?? item?.call_id ?? null,
              receiptPaths: receipts,
            });
          }
          if (notification.method === "turn/completed" && params?.threadId === parentThreadId) {
            parentTurnCompleted = true;
          }
        });

        const started = await client.request(
          "thread/start",
          {
            model: "gpt-5.5",
            cwd: workspace,
            approvalPolicy: "never",
            sandbox: "read-only",
            threadSource: "user",
            experimentalRawEvents: true,
            config: { "features.multi_agent": true },
          },
          { timeoutMs: 120_000 },
        );
        parentThreadId = started.thread.id;
        traceNativeLive("parent-thread-started", { parentThreadId });

        const requesterSessionKey = "live:streamed";
        const historyOwner = createCodexNativeSubagentHistoryOwner({
          parentThreadId,
          sessionId: "live-parent-session",
          binding: {
            appServerRuntimeFingerprint: buildCodexAppServerRuntimeFingerprint({
              appServer: { ...runtime, start: startOptions },
              appServerVersion: client.getServerVersion(),
              runtimeIdentity: client.getRuntimeIdentity(),
            }),
          },
        });
        expect(historyOwner).toBeDefined();
        const taskRuntimeScope = { requesterSessionKey } as AgentHarnessTaskRuntimeScope;
        const registration = {
          parentThreadId,
          requesterSessionKey,
          taskRuntimeScope,
          historyOwner,
          agentId: "live",
        };
        const streamed = createDeliveryRecorder([], requesterSessionKey);
        const monitor = new CodexNativeSubagentMonitor(client as never, streamed.runtime);
        const parentRegistration = monitor.registerParent(registration);

        // Detached-child scenario: the parent replies immediately while the
        // child still owes its own model round (plus a sleep for margin), so
        // the parent turn completes first, like an OpenClaw run cleaning up
        // after yield while its native subagent is still working.
        traceNativeLive("parent-turn-start-request", { parentThreadId });
        const turn = await client.request(
          "turn/start",
          {
            threadId: parentThreadId,
            input: [
              {
                type: "text",
                text: "Spawn exactly one subagent with this exact task: 'First run the shell command sleep 20 and wait for it to finish. Then reply with exactly the word BANANA42.' Do not wait for the subagent to finish. Reply DONE immediately after spawning it.",
                text_elements: [],
              },
            ],
          },
          { timeoutMs: 300_000 },
        );
        parentRegistration.bindTurn(turn.turn.id);
        traceNativeLive("parent-turn-bound", { turnId: turn.turn.id });

        const runningTask = await waitFor(
          () => {
            const task = streamed.records[0];
            return parentTurnCompleted &&
              task &&
              isJsonObject(task.detail) &&
              typeof task.detail.nativeTurnId === "string"
              ? task
              : undefined;
          },
          300_000,
          "parent completion and observed child assignment",
        );
        expect(streamed.records).toHaveLength(1);
        expect(runningTask).toMatchObject({
          status: "running",
          deliveryStatus: "not_applicable",
          requesterSessionKey,
          detail: { nativeHistory: historyOwner },
        });
        // Preserve the actual unfinished row before terminal events reach this monitor.
        const recoveryTask = structuredClone(runningTask);
        expect(streamed.deliveries).toHaveLength(0);
        traceNativeLive("parent-unregister-start", {
          tasks: streamed.records.map((task) => ({
            runId: task.runId ?? null,
            status: task.status,
            deliveryStatus: task.deliveryStatus,
          })),
        });
        await parentRegistration.unregister();
        traceNativeLive("parent-unregister-complete");

        const delivery = await waitFor(
          () => streamed.deliveries[0],
          420_000,
          "detached child completion delivery",
        );
        expect(delivery.status).toBe("succeeded");
        expect(delivery.result).toMatch(/BANANA42/iu);
        const childThreadId = delivery.childSessionId;

        // Canonical protocol shape: lineage plus terminal turn from history.
        const read = await client.request(
          "thread/read",
          { threadId: childThreadId, includeTurns: true },
          { timeoutMs: 60_000 },
        );
        expect((read.thread as unknown as JsonObject).parentThreadId).toBe(parentThreadId);
        const turns = read.thread.turns ?? [];
        expect(turns.at(-1)?.status).toBe("completed");

        const page = await client.request(
          "thread/turns/list",
          { threadId: childThreadId, limit: 1, sortDirection: "desc", itemsView: "full" },
          { timeoutMs: 60_000 },
        );
        const pageTurns = isJsonObject(page) && Array.isArray(page.data) ? page.data : [];
        const latestTurn = isJsonObject(pageTurns[0]) ? pageTurns[0] : undefined;
        expect(latestTurn?.status).toBe("completed");

        // Replay the saved unfinished row through a new monitor with the same owner.
        monitor.dispose();
        const recovery = createDeliveryRecorder([recoveryTask], requesterSessionKey);
        traceNativeLive("recovery-fixture", {
          tasks: recovery.records.map((task) => ({
            runId: task.runId ?? null,
            requesterSessionKey: task.requesterSessionKey ?? null,
            hasHistoryOwner: isJsonObject(task.detail) && isJsonObject(task.detail.nativeHistory),
            nativeTurnId: isJsonObject(task.detail) ? (task.detail.nativeTurnId ?? null) : null,
          })),
        });
        const recoveryMonitor = new CodexNativeSubagentMonitor(client as never, recovery.runtime);
        const recoveryRegistration = recoveryMonitor.registerParent(registration);
        await recoveryRegistration.unregister();
        const recovered = await waitFor(
          () => recovery.deliveries[0],
          120_000,
          "history-based completion recovery",
        );
        expect(recovered.childSessionId).toBe(childThreadId);
        expect(recovered.status).toBe("succeeded");
        expect(recovered.result).toMatch(/BANANA42/iu);
      } finally {
        await client?.closeAndWait();
        await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      }
    });
  }, 900_000);
});
