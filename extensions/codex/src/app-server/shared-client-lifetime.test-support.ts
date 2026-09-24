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
import type { CodexAppServerStartOptions } from "./config.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import {
  captureCodexAppServerClientLifetime,
  captureSharedCodexAppServerCatalogLifetime,
  createIsolatedCodexAppServerClient,
  getLeasedSharedCodexAppServerClient,
  getSharedCodexAppServerClient,
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
  it.each(["shared", "isolated"] as const)(
    "joins %s transport startup and closes a client returned after its deadline",
    async (kind) => {
      vi.useFakeTimers();
      const harness = createClientHarness({ autoEmitExit: false });
      const stdinClosed = once(harness.process.stdin, "close");
      let finishStart!: (client: CodexAppServerClient) => void;
      const starting = new Promise<CodexAppServerClient>((resolve) => {
        finishStart = resolve;
      });
      const startSpy = vi.spyOn(CodexAppServerClient, "start").mockReturnValue(starting);
      const acquire =
        kind === "shared"
          ? getLeasedSharedCodexAppServerClient
          : createIsolatedCodexAppServerClient;
      let settled = false;
      const pending = acquire({ timeoutMs: 50 });
      const rejected = expect(pending).rejects.toThrow("codex app-server initialize timed out");
      void pending.catch(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(startSpy).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(50);
      try {
        expect(settled).toBe(false);
        finishStart(harness.client);
        await stdinClosed;
        expect(harness.stdinDestroyed).toBe(true);
        expect(settled).toBe(false);
      } finally {
        finishStart(harness.client);
        harness.emitExit();
        await rejected;
      }
      expect(harness.process.exitCode).toBe(0);
    },
  );

  it.each([
    ["shared", "validation"],
    ["shared", "abort"],
    ["shared", "timeout"],
    ["isolated", "validation"],
    ["isolated", "abort"],
    ["isolated", "timeout"],
  ] as const)(
    "awaits physical exit after %s startup %s before another attempt",
    async (kind, mode) => {
      vi.useFakeTimers();
      const live = new Set<ReturnType<typeof createClientHarness>>();
      const startSpy = vi.spyOn(CodexAppServerClient, "start");
      const acquire =
        kind === "shared"
          ? getLeasedSharedCodexAppServerClient
          : createIsolatedCodexAppServerClient;
      const failure = new Error("fixture auth validation failed");
      rejectAuth(failure);

      for (let attempt = 0; attempt < 3; attempt++) {
        const harness = createClientHarness({ autoEmitExit: false });
        const stdinClosed = once(harness.process.stdin, "close");
        startSpy.mockImplementationOnce(async () => {
          live.add(harness);
          harness.process.once("exit", () => live.delete(harness));
          return harness.client;
        });
        let settled = false;
        const controller = new AbortController();
        const pending = acquire({ timeoutMs: 50, abandonSignal: controller.signal });
        const rejected = expect(pending).rejects.toThrow(
          mode === "validation"
            ? failure.message
            : `codex app-server initialize ${mode === "abort" ? "aborted" : "timed out"}`,
        );
        void pending.catch(() => {
          settled = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        if (mode === "validation") {
          const closeStarted = new Promise<void>((resolve) => {
            harness.client.addCloseHandler(() => resolve());
          });
          const initialize = JSON.parse(harness.writes[0]!);
          harness.send({
            id: initialize.id,
            result: { userAgent: `codex-cli/${CODEX_APP_SERVER_VERSION}` },
          });
          // Catalog identity resolves through real I/O before auth can reject startup.
          await closeStarted;
        } else if (mode === "abort") {
          controller.abort();
        }
        await vi.advanceTimersByTimeAsync(mode === "timeout" ? 50 : 0);
        try {
          // Catalog identity can await real filesystem I/O outside the fake clock.
          await stdinClosed;
          expect(harness.stdinDestroyed).toBe(true);
          expect(settled).toBe(false);
        } finally {
          harness.emitExit();
          await rejected;
        }
        expect(live.size).toBe(0);
      }
      expect(startSpy).toHaveBeenCalledTimes(3);
    },
  );

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
