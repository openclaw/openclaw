import { once } from "node:events";
import type {
  AgentHarnessTaskRecord,
  AgentHarnessTaskRuntime,
} from "openclaw/plugin-sdk/agent-harness-task-runtime";
import { expect, it, vi } from "vitest";
import {
  codexCatalogResidentHomeKey,
  subscribeCodexCatalogEvents,
} from "../session-catalog-events.js";
import { CodexAppServerClient } from "./client.js";
import { resolveCodexAppServerRuntimeOptions } from "./config-runtime.js";
import type { CodexAppServerStartOptions } from "./config.js";
import { createCodexAppServerModelCatalog } from "./model-catalog.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import { getSharedCodexAppServerClientState } from "./shared-client-lifecycle.js";
import { registerSharedClientStartupTests } from "./shared-client-startup.test-support.js";
import {
  captureCodexAppServerClientLifetime,
  captureSharedCodexAppServerCatalogLifetime,
  clearSharedCodexAppServerClientAndWait,
  clearSharedCodexAppServerClientIfCurrentAndUnclaimed,
  createIsolatedCodexAppServerClient,
  getLeasedSharedCodexAppServerClient,
  getSharedCodexAppServerClient,
  readCodexAppServerClientProcessIdentity,
  releaseLeasedSharedCodexAppServerClient,
  retainSharedCodexAppServerClientByInstanceId,
  retainSharedCodexAppServerClientIfCurrent,
  retireSharedCodexAppServerClientIfCurrent,
} from "./shared-client.js";
import { createClientHarness } from "./test-support.js";
import { CodexAdoptedThreadActiveError } from "./thread-lifecycle-errors.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

/** Register under the shared-client suite so its auth mocks and cleanup remain authoritative. */
export function registerSharedClientLifetimeTests(
  redirectNextStartToWebSocket: () => void,
  rejectAuth: (error: Error) => void,
) {
  it("keeps the current client registered while a staggered sibling lease is active after catalog disposal", async () => {
    const first = createClientHarness();
    const replacement = createClientHarness();
    const startSpy = vi
      .spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(first.client)
      .mockResolvedValueOnce(replacement.client);

    const pluginConfig = {
      appServer: { transport: "websocket", url: "ws://127.0.0.1:12345" },
    };
    const params = {
      config: {},
      agentId: "main",
      agentDir: "/tmp/openclaw-agent",
      workspaceDir: "/synthetic/workspace",
    };
    const options = {
      config: params.config,
      agentDir: params.agentDir,
      startOptions: resolveCodexAppServerRuntimeOptions({ pluginConfig }).start,
      timeoutMs: 1000,
    };
    const completedRunLease = getLeasedSharedCodexAppServerClient(options);
    const siblingRunLease = getLeasedSharedCodexAppServerClient(options);
    await sendInitializeResult(first, "openclaw/0.149.0 (macOS; test)");
    await expect(completedRunLease).resolves.toBe(first.client);
    await expect(siblingRunLease).resolves.toBe(first.client);

    await import("./sandbox-guard.js");
    const catalog = createCodexAppServerModelCatalog("codex");
    const loading = catalog.load(params, pluginConfig);
    const modelList = JSON.parse(await first.waitForWrite(2));
    expect(modelList.method).toBe("model/list");
    first.send({ id: modelList.id, result: { data: [] } });
    const account = JSON.parse(await first.waitForWrite(3));
    expect(account.method).toBe("account/read");
    first.send({
      id: account.id,
      result: { account: { type: "apiKey" }, requiresOpenaiAuth: true },
    });
    await loading;

    expect(releaseLeasedSharedCodexAppServerClient(first.client)).toBe(true);
    await catalog.dispose();
    expect(clearSharedCodexAppServerClientIfCurrentAndUnclaimed(first.client)).toEqual({
      found: true,
      closed: false,
      activeLeases: 1,
      pendingAcquires: 0,
    });
    expect(first.process.stdin.destroyed).toBe(false);

    const staggeredLease = await getLeasedSharedCodexAppServerClient(options);
    expect(staggeredLease).toBe(first.client);
    expect(startSpy).toHaveBeenCalledTimes(1);
    const pending = staggeredLease.request("thread/list", { limit: 1 });
    const request = JSON.parse(await first.waitForWrite(4));
    expect(request.method).toBe("thread/list");
    first.send({ id: request.id, result: { data: [], nextCursor: null } });
    await expect(pending).resolves.toEqual({ data: [], nextCursor: null });

    expect(releaseLeasedSharedCodexAppServerClient(first.client)).toBe(true);
    expect(releaseLeasedSharedCodexAppServerClient(first.client)).toBe(true);
    expect(clearSharedCodexAppServerClientIfCurrentAndUnclaimed(first.client)).toEqual({
      found: true,
      closed: true,
      activeLeases: 0,
      pendingAcquires: 0,
    });
    expect(first.process.stdin.destroyed).toBe(true);
  });

  it.each([
    { kind: "shared", retainedLifetime: false, exitBeforeRetry: false },
    { kind: "isolated", retainedLifetime: false, exitBeforeRetry: false },
    { kind: "shared", retainedLifetime: true, exitBeforeRetry: false },
    { kind: "shared", retainedLifetime: false, exitBeforeRetry: true },
  ] as const)(
    "retains an unconfirmed late $kind startup (retained lifetime: $retainedLifetime, exit before retry: $exitBeforeRetry)",
    async ({ kind, retainedLifetime, exitBeforeRetry }) => {
      vi.useFakeTimers();
      const lifetime = getSharedCodexAppServerClientState().startup;
      const originalCleanups = lifetime.cleanups;
      if (retainedLifetime) {
        delete lifetime.cleanups;
      }
      const harness = createClientHarness({ autoEmitExit: false });
      const replacement = createClientHarness({ autoEmitExit: false });
      const stdinClosed = once(harness.process.stdin, "close");
      let finishStart!: (client: CodexAppServerClient) => void;
      const starting = new Promise<CodexAppServerClient>((resolve) => {
        finishStart = resolve;
      });
      const start = vi
        .spyOn(CodexAppServerClient, "start")
        .mockReturnValueOnce(starting)
        .mockResolvedValueOnce(replacement.client);
      const onStartedClient = vi.fn();
      const acquire =
        kind === "shared"
          ? getLeasedSharedCodexAppServerClient
          : createIsolatedCodexAppServerClient;
      const pending = acquire({ timeoutMs: 50, onStartedClient });
      const acquisitionResult = pending.catch((error: unknown) => error);
      let disposal: Promise<void> | undefined;
      let retry: Promise<void> | undefined;
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(start).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(50);
        // Terminal cleanup begins before the timed-out producer returns its physical client.
        disposal = clearSharedCodexAppServerClientAndWait({ exitTimeoutMs: 20 });
        const disposalResult = disposal.catch((error: unknown) => error);
        finishStart(harness.client);
        await vi.advanceTimersByTimeAsync(0);
        expect(harness.stdinDestroyed).toBe(true);
        await stdinClosed;
        await vi.advanceTimersByTimeAsync(2_020);
        expect(await acquisitionResult).toMatchObject({
          message: expect.stringContaining("cleanup did not confirm transport exit"),
        });
        expect(await disposalResult).toMatchObject({
          message: expect.stringContaining("cleanup did not confirm transport exit"),
        });
        expect(onStartedClient).not.toHaveBeenCalled();
        expect(readCodexAppServerClientProcessIdentity(harness.client)).toMatchObject({
          command: expect.any(String),
          argsFingerprint: expect.any(String),
        });
        await expect(getSharedCodexAppServerClient()).rejects.toThrow("initialize aborted");
        expect(start).toHaveBeenCalledOnce();
        expect(getSharedCodexAppServerClientState().startup).toBe(lifetime);

        if (exitBeforeRetry) {
          expect(lifetime.cleanups?.size).toBe(1);
          harness.emitExit();
          expect(lifetime.cleanups?.size).toBe(0);
          await expect(getSharedCodexAppServerClient()).rejects.toThrow("initialize aborted");
        }

        let settled = false;
        retry = clearSharedCodexAppServerClientAndWait({ exitTimeoutMs: 20 });
        void retry.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(exitBeforeRetry);
        harness.emitExit();
        await retry;

        const next = getSharedCodexAppServerClient({ timeoutMs: 1_000 });
        await sendInitializeResult(replacement, `codex-cli/${CODEX_APP_SERVER_VERSION}`);
        await expect(next).resolves.toBe(replacement.client);
      } finally {
        finishStart(harness.client);
        harness.emitExit();
        replacement.emitExit();
        if (retainedLifetime && !lifetime.cleanups) {
          lifetime.cleanups = originalCleanups;
        }
        await Promise.allSettled([pending, disposal, retry]);
        await clearSharedCodexAppServerClientAndWait();
        await replacement.client.closeAndWait();
      }
    },
  );

  it("reports late startup cleanup failure after physical exit", async () => {
    vi.useFakeTimers();
    const harness = createClientHarness({ autoEmitExit: false });
    let finishStart!: (client: CodexAppServerClient) => void;
    const starting = new Promise<CodexAppServerClient>((resolve) => {
      finishStart = resolve;
    });
    vi.spyOn(CodexAppServerClient, "start").mockReturnValueOnce(starting);
    const closeError = new Error("late close observer failed after exit");
    const close = harness.client.closeAndWait.bind(harness.client);
    const closing = vi
      .spyOn(harness.client, "closeAndWait")
      .mockImplementationOnce(async (options) => {
        await close(options);
        throw closeError;
      });
    const pending = getLeasedSharedCodexAppServerClient({ timeoutMs: 50 });
    const acquisitionResult = pending.catch((error: unknown) => error);
    let disposal: Promise<void> | undefined;
    try {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(50);
      disposal = clearSharedCodexAppServerClientAndWait();
      const disposalResult = disposal.catch((error: unknown) => error);
      finishStart(harness.client);
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.stdinDestroyed).toBe(true);
      harness.emitExit();
      expect(await acquisitionResult).toBe(closeError);
      expect(await disposalResult).toBe(closeError);
      expect(closing).toHaveBeenCalledOnce();
      await expect(clearSharedCodexAppServerClientAndWait()).resolves.toBeUndefined();
    } finally {
      finishStart(harness.client);
      harness.emitExit();
      await Promise.allSettled([pending, disposal]);
      await clearSharedCodexAppServerClientAndWait();
    }
  });

  registerSharedClientStartupTests(rejectAuth);

  it("keeps a retired one-shot client alive until native subagent completion", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(harness.client);

    const clientPromise = getLeasedSharedCodexAppServerClient({ timeoutMs: 1000 });
    await sendInitializeResult(harness, "openclaw/0.149.0 (Linux; test)");
    const client = await clientPromise;
    const deliverCompletion = vi.fn(async () => ({ delivered: true, path: "direct" as const }));
    const task: AgentHarnessTaskRecord = {
      taskId: "child-thread",
      runId: "codex-thread:child-thread",
      runtime: "subagent",
      taskKind: "codex-native",
      ownerKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      scopeKind: "session",
      task: "inspect the repo",
      status: "running",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      createdAt: Date.now(),
    };
    let created = false;
    const createTask = vi.fn(() => {
      created = true;
      return task;
    });
    const taskRuntime: AgentHarnessTaskRuntime = {
      assertTaskAssignmentSupported: vi.fn(),
      createRunningTaskRun: createTask,
      tryCreateRunningTaskRun: createTask,
      recordTaskRunProgressByRunId: vi.fn(() => []),
      finalizeTaskRunByRunId: vi.fn((params) => {
        task.status = params.status;
        task.endedAt = params.endedAt;
        task.terminalSummary = params.terminalSummary ?? undefined;
        return [task];
      }),
      listTaskRecords: vi.fn(() => (created ? [task] : [])),
      setDetachedTaskDeliveryStatusByRunId: vi.fn((params) => {
        task.deliveryStatus = params.deliveryStatus;
        return [task];
      }),
    };
    const retainClient = vi.fn(() => retainSharedCodexAppServerClientIfCurrent(client));
    const monitor = new codexNativeSubagentMonitorRuntime.Monitor(
      client,
      {
        captureAgentHarnessCompletionCustody: () => undefined,
        createAgentHarnessTaskEventSink: () => () => {},
        createAgentHarnessTaskRuntime: vi.fn(() => taskRuntime),
        deliverAgentHarnessTaskCompletion: deliverCompletion,
      },
      { retainClient },
    );
    monitor.registerParent({
      parentThreadId: "parent-thread",
      requesterSessionKey: "agent:main:main",
      taskRuntimeScope: { requesterSessionKey: "agent:main:main" },
      agentId: "main",
    });

    harness.send({
      method: "thread/started",
      params: {
        thread: {
          id: "child-thread",
          parentThreadId: "parent-thread",
          preview: "inspect the repo",
          source: {
            subAgent: {
              thread_spawn: {
                parent_thread_id: "parent-thread",
                depth: 1,
                agent_path: "child-thread",
              },
            },
          },
        },
      },
    });
    await vi.waitFor(() => expect(retainClient).toHaveBeenCalledTimes(1));

    expect(releaseLeasedSharedCodexAppServerClient(client)).toBe(true);
    expect(retireSharedCodexAppServerClientIfCurrent(client)).toEqual({
      activeLeases: 1,
      closed: false,
    });
    expect(harness.process.stdin.destroyed).toBe(false);

    // The ordinary lease is gone, but native completion still explicitly owns
    // the detached process and repeated cleanup must not close that owner.
    expect(releaseLeasedSharedCodexAppServerClient(client)).toBe(false);
    expect(retireSharedCodexAppServerClientIfCurrent(client)).toEqual({
      activeLeases: 1,
      closed: false,
    });
    expect(harness.process.stdin.destroyed).toBe(false);

    harness.send({
      method: "turn/completed",
      params: {
        threadId: "child-thread",
        turn: {
          id: "child-turn",
          status: "completed",
          items: [
            {
              id: "child-final",
              type: "agentMessage",
              phase: "final_answer",
              text: "child final result",
            },
          ],
          error: null,
        },
      },
    });

    await vi.waitFor(() => expect(deliverCompletion).toHaveBeenCalledTimes(1));
    expect(deliverCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ childSessionId: "child-thread", result: "child final result" }),
    );
    expect(task).toMatchObject({
      status: "succeeded",
      deliveryStatus: "delivered",
      terminalSummary: "child final result",
    });
    expect(harness.process.stdin.destroyed).toBe(true);
  });

  it("connects catalog events at physical startup without retaining a client lease", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
    const startOptions: CodexAppServerStartOptions = {
      transport: "websocket",
      command: "codex",
      args: ["app-server"],
      url: "wss://catalog-events.example.test/codex",
      authToken: "synthetic-catalog-token",
      headers: {},
    };
    const homeKey = await codexCatalogResidentHomeKey({ startOptions });
    const receive = vi.fn();
    const stop = subscribeCodexCatalogEvents(homeKey, receive);
    try {
      const acquiring = getLeasedSharedCodexAppServerClient({ startOptions, timeoutMs: 1_000 });
      await sendInitializeResult(harness, "openclaw/0.151.0 (Linux; test)");
      const client = await acquiring;
      const event = { method: "thread/archived", params: { threadId: "thread-1" } };
      harness.send(event);
      expect(receive).toHaveBeenCalledExactlyOnceWith(
        event,
        expect.any(Function),
        expect.objectContaining({ closed: false }),
      );
      retireSharedCodexAppServerClientIfCurrent(client);
      expect(releaseLeasedSharedCodexAppServerClient(client)).toBe(true);
      expect(client.getCloseError()).toBeDefined();
    } finally {
      stop();
      harness.client.close();
    }
  });

  it.each([
    { name: "isolated stdio", transport: "stdio", allowed: true },
    { name: "isolated websocket", transport: "websocket", allowed: false },
    { name: "isolated unix", transport: "unix", allowed: false },
    { name: "shared websocket", transport: "websocket", allowed: false, shared: true },
    { name: "shared unix", transport: "unix", allowed: false, shared: true },
    { name: "redirected stdio", transport: "stdio", allowed: false, redirect: true },
    { name: "stdio proxy", transport: "stdio", allowed: false, args: ["app-server", "proxy"] },
    {
      name: "stdio option value",
      transport: "stdio",
      allowed: true,
      args: ["app-server", "--cd", "proxy"],
    },
  ] as const)(
    "captures thread configuration lifetime over $name while restricting native-process ownership",
    async (scenario) => {
      const harness = createClientHarness();
      vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
      if ("redirect" in scenario) {
        redirectNextStartToWebSocket();
      }
      const acquire = (
        "shared" in scenario
          ? getLeasedSharedCodexAppServerClient
          : createIsolatedCodexAppServerClient
      )({
        timeoutMs: 1_000,
        startOptions: {
          transport: scenario.transport,
          command: "codex",
          args: scenario.args ? [...scenario.args] : ["app-server"],
          headers: {},
          ...(scenario.transport === "websocket" ? { url: "ws://127.0.0.1:8123" } : {}),
          ...(scenario.transport === "unix" ? { url: "unix:///tmp/synthetic-codex.sock" } : {}),
        },
      });
      await sendInitializeResult(harness, "openclaw/0.151.0 (Linux; test)");
      const client = await acquire;
      const assertConfigurationCurrent = captureCodexAppServerClientLifetime(
        client,
        "thread-configuration",
      );
      expect(assertConfigurationCurrent).not.toThrow();
      if (!scenario.allowed) {
        const writes = harness.writes.length;
        expect(() => captureCodexAppServerClientLifetime(client, "native-process")).toThrow(
          "reconnect through managed local stdio",
        );
        expect(harness.writes).toHaveLength(writes);
        expect(client.getCloseError()).toBeUndefined();
      } else {
        const assertCurrent = captureCodexAppServerClientLifetime(client, "native-process");
        expect(assertCurrent).not.toThrow();
        client.close();
        expect(assertCurrent).toThrow(CodexAdoptedThreadActiveError);
      }
      if ("shared" in scenario) {
        releaseLeasedSharedCodexAppServerClient(client);
      }
      client.close();
      expect(assertConfigurationCurrent).toThrow(CodexAdoptedThreadActiveError);
    },
  );

  it("captures registered client lifetime independently of lease counts", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
    expect(() => captureCodexAppServerClientLifetime(harness.client, "connection")).toThrow(
      CodexAdoptedThreadActiveError,
    );
    const acquire = getLeasedSharedCodexAppServerClient({ timeoutMs: 1_000 });
    await sendInitializeResult(harness, "openclaw/0.151.0 (Linux; test)");
    const client = await acquire;
    const assertCurrent = captureCodexAppServerClientLifetime(client, "native-process");
    const retained = retainSharedCodexAppServerClientByInstanceId(client.getInstanceId());
    expect(assertCurrent).not.toThrow();
    retained?.release();
    expect(releaseLeasedSharedCodexAppServerClient(client)).toBe(true);
    expect(assertCurrent).not.toThrow();
    const catalogCurrent = captureSharedCodexAppServerCatalogLifetime(client);
    const configWrite = client.request("config/batchWrite", { edits: [], reloadUserConfig: false });
    const written = JSON.parse(harness.writes.at(-1)!);
    harness.send({ id: written.id, result: {} });
    await configWrite;
    expect(catalogCurrent()).toBe(false);
    expect(assertCurrent).not.toThrow();
    client.close();
    expect(assertCurrent).toThrow(CodexAdoptedThreadActiveError);
  });

  it.each(["websocket", "unix", "proxy"] as const)(
    "preserves supervised connection lifetime over %s without claiming its native process",
    async (transport) => {
      const harness = createClientHarness();
      vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
      const acquire = getLeasedSharedCodexAppServerClient({
        timeoutMs: 1_000,
        startOptions: {
          transport: transport === "proxy" ? "stdio" : transport,
          command: "codex",
          args: transport === "proxy" ? ["app-server", "proxy"] : ["app-server"],
          headers: {},
          ...(transport === "websocket" ? { url: "ws://127.0.0.1:8123" } : {}),
          ...(transport === "unix" ? { url: "unix:///tmp/synthetic-codex.sock" } : {}),
        },
      });
      await sendInitializeResult(harness, "openclaw/0.151.0 (Linux; test)");
      const client = await acquire;
      try {
        const assertCurrent = captureCodexAppServerClientLifetime(client, "connection");
        expect(assertCurrent).not.toThrow();
        const release = retainSharedCodexAppServerClientIfCurrent(client);
        expect(assertCurrent).not.toThrow();
        release?.();
        expect(assertCurrent).not.toThrow();
        expect(captureCodexAppServerClientLifetime(client, "connection")).not.toThrow();
      } finally {
        releaseLeasedSharedCodexAppServerClient(client);
        client.close();
      }
    },
  );

  it.each(["acquire", "retain"] as const)(
    "preserves captured client lifetime after a completed sibling %s",
    async (operation) => {
      const harness = createClientHarness();
      vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
      const options = {
        timeoutMs: 1_000,
        config: {},
        startOptions: {
          transport: "stdio",
          homeScope: "agent",
          command: "codex",
          args: ["app-server"],
          headers: {},
        } satisfies CodexAppServerStartOptions,
      };
      const acquire = getLeasedSharedCodexAppServerClient(options);
      await sendInitializeResult(harness, "openclaw/0.149.0 (Linux; test)");
      const client = await acquire;
      const assertCurrent = captureCodexAppServerClientLifetime(client, "native-process");
      if (operation === "acquire") {
        expect(await getLeasedSharedCodexAppServerClient(options)).toBe(client);
        expect(releaseLeasedSharedCodexAppServerClient(client)).toBe(true);
      } else {
        retainSharedCodexAppServerClientIfCurrent(client)?.();
      }

      expect(assertCurrent).not.toThrow();
      expect(captureCodexAppServerClientLifetime(client, "native-process")).not.toThrow();
      expect(releaseLeasedSharedCodexAppServerClient(client)).toBe(true);
    },
  );

  it("preserves client lifetime while an unleased acquire is pending", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
    const acquire = getLeasedSharedCodexAppServerClient({ timeoutMs: 1_000 });
    await sendInitializeResult(harness, "openclaw/0.149.0 (Linux; test)");
    const client = await acquire;
    const assertCurrent = captureCodexAppServerClientLifetime(client, "native-process");
    let observedPendingAcquire = false;
    await getSharedCodexAppServerClient({
      timeoutMs: 1_000,
      onStartedClient: () => {
        observedPendingAcquire = true;
        expect(captureCodexAppServerClientLifetime(client, "native-process")).not.toThrow();
        expect(assertCurrent).not.toThrow();
      },
    });

    expect(observedPendingAcquire).toBe(true);
    expect(assertCurrent).not.toThrow();
    expect(captureCodexAppServerClientLifetime(client, "native-process")).not.toThrow();
    expect(releaseLeasedSharedCodexAppServerClient(client)).toBe(true);
  });

  it.each(["native-process", "thread-configuration"] as const)(
    "revokes %s ownership when its physical client is retired",
    async (requiredOwnership) => {
      const harness = createClientHarness();
      vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
      const acquire = getLeasedSharedCodexAppServerClient({ timeoutMs: 1_000 });
      await sendInitializeResult(harness, "openclaw/0.149.0 (Linux; test)");
      const client = await acquire;
      const assertExclusive = captureCodexAppServerClientLifetime(client, requiredOwnership);
      retireSharedCodexAppServerClientIfCurrent(client);

      expect(assertExclusive).toThrow(CodexAdoptedThreadActiveError);
      expect(() => captureCodexAppServerClientLifetime(client, requiredOwnership)).toThrow(
        CodexAdoptedThreadActiveError,
      );
      expect(harness.stdinDestroyed).toBe(false);
      expect(releaseLeasedSharedCodexAppServerClient(client)).toBe(true);
      expect(harness.stdinDestroyed).toBe(true);
    },
  );
}

async function sendInitializeResult(
  harness: ReturnType<typeof createClientHarness>,
  userAgent: string,
): Promise<void> {
  const initialize = JSON.parse(await harness.waitForWrite(0)) as { id: number; method: string };
  expect(initialize.method).toBe("initialize");
  harness.send({ id: initialize.id, result: { userAgent } });
}
