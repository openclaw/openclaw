import fs from "node:fs/promises";
import path from "node:path";
import {
  AgentHarnessPreflightError,
  embeddedAgentLog,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { setupStartupLifecycle } from "./attempt-startup-lifecycle.test-support.js";
import {
  answerInitialize,
  captureExpectedRuntimeArtifact,
  createPairedAttemptRuntime,
  createAttemptPaths,
  createAttemptClientHarness,
  createAttemptThreadStarter,
  createAttemptParams,
  readHarnessMessages,
  readHarnessRequestMethods,
  waitForRequest,
  waitForThreadStart,
  type AttemptClientHarness as ClientHarness,
} from "./attempt-startup.test-support.js";
import { isCodexAppServerStartupError } from "./attempt-timeouts.js";
import { CodexAppServerClient, isCodexAppServerRequestTimeoutError } from "./client.js";
import { threadStartResult as createThreadStartResult } from "./codex-app-server.test-fixtures.js";
import {
  CODEX_PLUGINS_MARKETPLACE_NAME,
  type CodexPluginConfig,
  resolveCodexAppServerRuntimeOptions,
} from "./config.js";
import { sandboxExecServerRegistry } from "./sandbox-exec-server-registry.js";
import { releaseCodexSandboxExecServerEnvironment } from "./sandbox-exec-server.js";
import { createSandboxContext } from "./sandbox-exec-server.test-helpers.js";
import { testCodexAppServerBindingStore } from "./session-binding.test-helpers.js";
import {
  createIsolatedCodexAppServerClient,
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
  retainSharedCodexAppServerClientIfCurrent,
  retireSharedCodexAppServerClientIfCurrent,
  type CodexAppServerClientFactory,
} from "./shared-client.js";
import { stubCodexInferenceTransportEnv } from "./test-support.js";
import {
  createLifecycleRequest,
  createCodexLifecycleHarness,
} from "./thread-lifecycle.test-fixtures.js";
import { retainCodexAppServerBindingSubscription } from "./thread-ownership.js";

vi.mock("./desktop-generation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./desktop-generation.js")>()),
  waitForCodexDesktopGeneration: async () => undefined,
}));

const tempRoots = new Set<string>();

const pluginConfig: CodexPluginConfig = { appServer: { command: "codex" } };

const startThreadWithHarness = createAttemptThreadStarter(tempRoots, pluginConfig);
type StartupOptions = NonNullable<Parameters<typeof startThreadWithHarness>[2]>;
const runStartup = (options: StartupOptions) => startThreadWithHarness(5_000, undefined, options);
const requestConfig = (requestTimeoutMs: number): CodexPluginConfig => ({
  appServer: { command: "codex", requestTimeoutMs },
});
const outcome = <T>(run: Promise<T>) =>
  run.then(
    () => undefined,
    (error: unknown) => error,
  );
function releaseAttempt(result: Awaited<ReturnType<typeof runStartup>["run"]>) {
  result.turnRoute.release();
  result.releaseSharedClientLease();
}
function expectStartupError(error: unknown, reason: "aborted" | "timed_out", message: string) {
  expect(error).toBeInstanceOf(Error);
  expect(isCodexAppServerStartupError(error, reason)).toBe(true);
  expect(error).toHaveProperty("message", message);
}

const threadStartResult = (threadId = "thread-1") => createThreadStartResult(threadId, "/repo");

describe("startCodexAttemptThread", () => {
  setupStartupLifecycle(tempRoots, () => {
    vi.useRealTimers();
    stubCodexInferenceTransportEnv();
  });

  it.each([false, true])(
    "checks the expected artifact before startup (matches=%s)",
    async (matches) => {
      const paths = createAttemptPaths(tempRoots);
      await fs.mkdir(paths.workspaceDir, { recursive: true });
      const command = path.join(paths.workspaceDir, "codex-runtime");
      await fs.writeFile(command, "native-v1");
      const configuredPlugin = { appServer: { command } };
      const expected = matches
        ? await captureExpectedRuntimeArtifact(
            resolveCodexAppServerRuntimeOptions({ pluginConfig: configuredPlugin }),
          )
        : { id: "codex-app-server:v1:wrong", fingerprint: "0".repeat(64) };
      const { harness, run } = runStartup({
        paths,
        pluginConfig: configuredPlugin,
        runtimeArtifactRequest: { expected },
      });
      if (!matches) {
        await expect(run).rejects.toThrow("does not match verified inference");
        expect(harness.writes).toEqual([]);
        return;
      }
      await answerInitialize(harness);
      const threadStart = await waitForThreadStart(harness);
      harness.send({ id: threadStart.id, result: threadStartResult() });
      const result = await run;
      expect(result.runtimeArtifact).toEqual(expected);
      releaseAttempt(result);
    },
  );

  it("preserves the healthy shared client and incognito history after a prewrite resume refusal", async () => {
    const paths = createAttemptPaths(tempRoots);
    const harness = createCodexLifecycleHarness({
      respond: createLifecycleRequest(async (method, params) => {
        if (method === "thread/start") {
          return threadStartResult(
            (params as { ephemeral?: boolean }).ephemeral ? "incognito" : "ordinary",
          );
        }
        throw new Error(`unexpected method: ${method}`);
      }),
    });
    const start = vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
    const common = {
      paths,
      harness,
      skipStartSpy: true,
      buildAttemptParams: () => ({ ...createAttemptParams(paths), disableTools: false }),
    };
    const ordinary = await startThreadWithHarness(5_000, undefined, common).run;
    await harness.endTurn(ordinary.thread.threadId);
    releaseAttempt(ordinary);
    const incognito = {
      ...common,
      buildAttemptParams: () => ({
        ...common.buildAttemptParams(),
        sessionId: "incognito-session",
        sessionKey: "agent:agent-1:dashboard:incognito-refusal",
      }),
    };
    const previous = await startThreadWithHarness(5_000, undefined, incognito).run;
    await retainCodexAppServerBindingSubscription(harness.client, previous.thread.threadId, {
      configFingerprint: previous.thread.liveThreadConfigFingerprint,
      ephemeralPolicy: previous.thread.liveThreadEphemeralPolicy,
    });
    releaseAttempt(previous);

    const sibling = retainSharedCodexAppServerClientIfCurrent(harness.client);
    expect(sibling).toBeTypeOf("function");
    const before = harness.writes.length;
    const refused = new AgentHarnessPreflightError("session owner revoked");
    const attemptParams = common.buildAttemptParams();
    const assertActive = () => {
      throw refused;
    };
    const hostCapabilities = { ...attemptParams.hostCapabilities, assertActive };
    const buildAttemptParams = () => ({ ...attemptParams, hostCapabilities });
    await expect(
      startThreadWithHarness(5_000, undefined, { ...common, buildAttemptParams }).run,
    ).rejects.toBe(refused);
    sibling?.();
    const continued = await startThreadWithHarness(5_000, undefined, incognito).run;
    expect(continued.client).toBe(harness.client);
    expect(continued.thread.threadId).toBe(previous.thread.threadId);
    expect(readHarnessMessages(harness.writes.slice(before)).map(({ method }) => method)).toEqual([
      "skills/list",
      "config/read",
      "configRequirements/read",
    ]);
    expect(start).toHaveBeenCalledTimes(1);
    releaseAttempt(continued);
  });

  it.each(["aborted", "timed_out"] as const)(
    "settles a retired-owner exit wait on %s without resuming early",
    async (reason) => {
      const paths = createAttemptPaths(tempRoots);
      const respond = createLifecycleRequest(async (method) => {
        if (method === "thread/start" || method === "thread/resume") {
          return threadStartResult("bound-thread");
        }
        throw new Error(`unexpected method: ${method}`);
      });
      const owner = createCodexLifecycleHarness({ respond });
      const ownerExitCodesAtResume: Array<number | null> = [];
      const healthy = createCodexLifecycleHarness({
        persistedThreads: ["bound-thread"],
        respond: async (method) => {
          if (method === "thread/resume") {
            ownerExitCodesAtResume.push(owner.process.exitCode);
          }
          return await respond(method);
        },
      });
      const start = vi
        .spyOn(CodexAppServerClient, "start")
        .mockResolvedValueOnce(owner.client)
        .mockResolvedValueOnce(healthy.client)
        .mockRejectedValue(new Error("unexpected replacement app-server"));
      const startOn = (harness: ClientHarness, signal?: AbortSignal, startupTimeoutMs = 5_000) =>
        startThreadWithHarness(startupTimeoutMs, signal, {
          paths,
          harness,
          skipStartSpy: true,
          buildAttemptParams: () => ({ ...createAttemptParams(paths), disableTools: false }),
        }).run;
      const bound = await startOn(owner);
      expect(
        testCodexAppServerBindingStore.read({
          kind: "session",
          agentId: "agent-1",
          sessionId: "session-1",
          sessionKey: "agent:agent-1:session-1",
        }),
      ).toMatchObject({ threadId: bound.thread.threadId });
      await owner.endTurn(bound.thread.threadId);
      releaseAttempt(bound);
      const releaseOwnerPeer = retainSharedCodexAppServerClientIfCurrent(owner.client);
      expect(releaseOwnerPeer).toBeTypeOf("function");
      retireSharedCodexAppServerClientIfCurrent(owner.client);
      // A handoff observes the owner's physical exit only after releasing its retain.
      const exitWaitStarted = createDeferred<void>();
      const addTransportExitHandler = owner.client.addTransportExitHandler.bind(owner.client);
      vi.spyOn(owner.client, "addTransportExitHandler").mockImplementation((handler) => {
        exitWaitStarted.resolve();
        return addTransportExitHandler(handler);
      });
      const stop = new AbortController();
      if (reason === "timed_out") {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      }
      const ended = outcome(startOn(healthy, stop.signal, reason === "aborted" ? 5_000 : 1_000));
      await exitWaitStarted.promise;
      if (reason === "aborted") {
        stop.abort();
      } else {
        await vi.advanceTimersByTimeAsync(1_000);
      }
      expect(isCodexAppServerStartupError(await ended, reason)).toBe(true);
      expect(owner.process.exitCode).toBeNull();
      expect(readHarnessRequestMethods(healthy)).not.toContain("thread/resume");
      expect(healthy.stdinDestroyed).toBe(reason === "timed_out");
      if (reason === "timed_out") {
        releaseOwnerPeer?.();
        return;
      }
      const successor = startOn(healthy);
      releaseOwnerPeer?.();
      const resumed = await successor;
      expect(resumed.client).toBe(healthy.client);
      expect(resumed.thread.threadId).toBe("bound-thread");
      expect(ownerExitCodesAtResume).toEqual([0]);
      expect(start).toHaveBeenCalledTimes(2);
      expect(healthy.stdinDestroyed).toBe(false);
      releaseAttempt(resumed);
    },
  );

  it.each([
    ["initialize", "client-acquire", false],
    ["thread/start", "thread-lifecycle", true],
  ] as const)(
    "records blocked %s in %s before cleanup (logger throws=%s)",
    async (method, stage, loggerThrows) => {
      // Keep transport exit and worker I/O live while the startup clock is frozen.
      vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
      const harness = createAttemptClientHarness();
      const paths = createAttemptPaths(tempRoots);
      const attemptParams = createAttemptParams(paths);
      const timeoutWarnings: { metadata: unknown; transportClosed: boolean }[] = [];
      vi.spyOn(embeddedAgentLog, "warn").mockImplementation((message, metadata) => {
        if (message === "codex app-server startup timed out") {
          timeoutWarnings.push({ metadata, transportClosed: harness.stdinDestroyed });
          if (loggerThrows) {
            throw new Error("diagnostic logger failed");
          }
        }
      });
      const { run } = startThreadWithHarness(500, undefined, {
        harness,
        paths,
        buildAttemptParams: () => attemptParams,
      });
      const runError = outcome(run);
      if (method !== "initialize") {
        await answerInitialize(harness);
      }
      for (let index = 0; ; index += 1) {
        const [request] = readHarnessMessages([await harness.waitForWrite(index)]);
        if (request?.method === method) {
          break;
        }
      }
      await vi.advanceTimersByTimeAsync(500);

      const error = await runError;
      if (method !== "initialize") {
        await vi.waitFor(() => expect(harness.stdinDestroyed).toBe(true), {
          interval: 1,
          timeout: 1_000,
        });
      }
      expectStartupError(error, "timed_out", "codex app-server startup timed out");
      expect(harness.stdinDestroyed).toBe(method !== "initialize");
      expect(timeoutWarnings).toEqual([
        {
          transportClosed: false,
          metadata: expect.objectContaining({
            runId: attemptParams.runId,
            sessionId: attemptParams.sessionId,
            stage,
            clientInstanceId: harness.client.getInstanceId(),
            clientPendingRequestMethods: [method],
            elapsedMs: 500,
            timeoutMs: 500,
          }),
        },
      ]);
      expect(JSON.stringify(timeoutWarnings)).not.toContain(paths.workspaceDir);
    },
  );

  it.each([
    ["acquire timeout", false],
    ["startup timeout", false],
    ["abort", false],
    ["acquire timeout", true],
  ] as const)(
    "preserves shared startup after %s (active peer=%s)",
    async (abandonment, withPeer) => {
      if (withPeer) {
        vi.useFakeTimers();
      } else {
        vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
      }
      const paths = createAttemptPaths(tempRoots);
      const controller = new AbortController();
      const sharedConfig = requestConfig(1_000);
      const startOptions = resolveCodexAppServerRuntimeOptions({
        pluginConfig: sharedConfig,
      }).start;
      const { harness, run, startSpy } = startThreadWithHarness(
        abandonment === "startup timeout" ? 500 : 3_000,
        controller.signal,
        { paths, pluginConfig: sharedConfig },
      );
      const initialize = JSON.parse(await harness.waitForWrite(0)) as { id: number };
      const acquire = () =>
        getLeasedSharedCodexAppServerClient({
          startOptions,
          agentDir: paths.agentDir,
          timeoutMs: 3_000,
          ...(!withPeer ? { pluginConfig: sharedConfig } : {}),
        });
      let peerAcquire: ReturnType<typeof getLeasedSharedCodexAppServerClient> | undefined;
      if (withPeer) {
        const started = createDeferred<void>();
        peerAcquire = getLeasedSharedCodexAppServerClient({
          startOptions,
          agentDir: paths.agentDir,
          timeoutMs: 3_000,
          onStartedClient: () => started.resolve(),
        });
        await started.promise;
      }
      const rejected = expect(run).rejects.toThrow(
        abandonment === "acquire timeout"
          ? "codex app-server initialize timed out"
          : abandonment === "startup timeout"
            ? "codex app-server startup timed out"
            : "codex app-server startup aborted",
      );
      if (abandonment === "abort") {
        controller.abort();
      } else {
        await vi.advanceTimersByTimeAsync(abandonment === "startup timeout" ? 500 : 1_000);
      }
      await rejected;
      expect(harness.stdinDestroyed).toBe(false);
      if (withPeer) {
        await answerInitialize(harness);
        await expect(peerAcquire).resolves.toBe(harness.client);
        await expect(acquire()).resolves.toBe(harness.client);
        expect(releaseLeasedSharedCodexAppServerClient(harness.client)).toBe(true);
      } else {
        const laterAcquire = acquire();
        harness.send({
          id: initialize.id,
          result: { userAgent: "openclaw/0.149.0 (macOS; test)" },
        });
        await expect(laterAcquire).resolves.toBe(harness.client);
        expect(readHarnessMessages(harness.writes).map(({ method }) => method)).not.toContain(
          "thread/start",
        );
      }
      expect(startSpy).toHaveBeenCalledTimes(1);
      expect(releaseLeasedSharedCodexAppServerClient(harness.client)).toBe(true);
    },
  );

  it("cleans up a client surfaced by a factory that later rejects", async () => {
    const { harness, run } = runStartup({
      attemptClientFactory: (factoryHarness) => async (options) => {
        options?.onStartedClient?.(factoryHarness.client);
        throw new Error("custom initialize failed");
      },
    });

    await expect(run).rejects.toThrow("custom initialize failed");
    expect(harness.stdinDestroyed).toBe(true);
  });

  it("closes each paired-node environment and client without interrupting an overlapping sibling", async () => {
    const runtime = createPairedAttemptRuntime();
    const input = (sessionId: string) => ({
      harness: createAttemptClientHarness(),
      paths: createAttemptPaths(tempRoots),
      sessionId,
    });
    const inputs = [input("overlap-1"), input("overlap-2")] as const;
    const start = vi.spyOn(CodexAppServerClient, "start").mockImplementation(async (options) => {
      const match = inputs.find(({ paths }) =>
        options?.env?.CODEX_HOME?.startsWith(`${paths.agentDir}${path.sep}`),
      );
      if (!match) {
        throw new Error(`Unexpected isolated Codex home: ${options?.env?.CODEX_HOME}`);
      }
      return match.harness.client;
    });
    const launch = async ({ harness, paths, sessionId }: ReturnType<typeof input>) => {
      const sandbox = {
        ...createSandboxContext({}),
        backendId: "node",
        backend: undefined,
        fsBridge: undefined,
        runtimeId: `paired-node-${sessionId}`,
        placementExecutionMode: "remote-exec" as const,
        placementNodeId: "paired-device-1",
        placementEnvironmentId: `environment-${sessionId}`,
        placementSessionId: sessionId,
        placementOwnerEpoch: 1,
      };
      const run = runStartup({
        harness,
        paths,
        skipStartSpy: true,
        runtime: runtime.runtime,
        sandbox,
        attemptClientFactory: () => createIsolatedCodexAppServerClient,
        buildAttemptParams: () => ({
          ...createAttemptParams(paths),
          sessionId,
          sessionKey: `agent:agent-1:${sessionId}`,
        }),
      }).run;
      await answerInitialize(harness);
      const environmentAdd = await waitForRequest(harness, "environment/add");
      harness.send({ id: environmentAdd.id, result: {} });
      const threadStart = await waitForThreadStart(harness);
      harness.send({ id: threadStart.id, result: threadStartResult(sessionId) });
      const result = await run;
      const environmentId = (environmentAdd.params as { environmentId?: string }).environmentId;
      expect(environmentId).toMatch(/^openclaw-node-/u);
      expect(
        readHarnessMessages(harness.writes).filter(({ method }) => method === "environment/add"),
      ).toHaveLength(1);
      return { result, sandbox, environmentId };
    };
    const [firstAttempt, secondAttempt] = await Promise.all([launch(inputs[0]), launch(inputs[1])]);
    const [{ harness: first }, { harness: second }] = inputs;

    expect(firstAttempt.result.client).toBe(first.client);
    expect(secondAttempt.result.client).toBe(second.client);
    expect(firstAttempt.environmentId).not.toBe(secondAttempt.environmentId);
    expect(start).toHaveBeenCalledTimes(2);
    const firstChannel = runtime.channels.find(({ sessionId }) => sessionId === "overlap-1");
    const secondChannel = runtime.channels.find(({ sessionId }) => sessionId === "overlap-2");
    await releaseCodexSandboxExecServerEnvironment(
      firstAttempt.sandbox,
      firstAttempt.result.sandboxEnvironment,
    );
    firstAttempt.result.releaseSharedClientLease();
    expect(first.process.stdin.destroyed).toBe(true);
    expect(second.process.stdin.destroyed).toBe(false);
    expect(firstChannel?.close).toHaveBeenCalledOnce();
    expect(secondChannel?.close).not.toHaveBeenCalled();
    await releaseCodexSandboxExecServerEnvironment(
      secondAttempt.sandbox,
      secondAttempt.result.sandboxEnvironment,
    );
    secondAttempt.result.releaseSharedClientLease();
    expect(second.process.stdin.destroyed).toBe(true);
    expect(secondChannel?.close).toHaveBeenCalledOnce();
    expect(sandboxExecServerRegistry.servers.size).toBe(0);
  });

  it("propagates environment registration failures for remote-exec placement", async () => {
    const sandbox = {
      ...createSandboxContext({}),
      placementExecutionMode: "remote-exec" as const,
    };
    const { harness, run } = runStartup({
      sandbox,
    });
    await answerInitialize(harness);
    const environmentAdd = await waitForRequest(harness, "environment/add");
    harness.send({
      id: environmentAdd.id,
      error: { code: -32603, message: "environment registration failed" },
    });

    await expect(run).rejects.toThrow("environment registration failed");
    expect(sandboxExecServerRegistry.servers.has(sandbox.runtimeId)).toBe(false);
    expect(readHarnessMessages(harness.writes).map(({ method }) => method)).not.toContain(
      "thread/start",
    );
  });

  it("closes a startup client that arrives after startup timeout", async () => {
    vi.useFakeTimers();
    let observedFactoryOptions: Parameters<CodexAppServerClientFactory>[0];
    let factoryCalls = 0;
    const factoryDone = createDeferred<void>();
    const factoryRelease = createDeferred<void>();
    const delayedFactoryPluginConfig = requestConfig(2_500);
    const { harness, run } = startThreadWithHarness(100, new AbortController().signal, {
      pluginConfig: delayedFactoryPluginConfig,
      attemptClientFactory: (factoryHarness) => async (options) => {
        try {
          factoryCalls += 1;
          observedFactoryOptions = options;
          await factoryRelease.promise;
          options?.onStartedClient?.(factoryHarness.client);
          return factoryHarness.client;
        } finally {
          factoryDone.resolve();
        }
      },
    });
    const rejected = expect(run).rejects.toThrow("codex app-server startup timed out");
    await vi.waitFor(() => expect(factoryCalls).toBe(1), { interval: 1 });
    await vi.advanceTimersByTimeAsync(100);

    try {
      await rejected;
    } finally {
      factoryRelease.resolve();
      await factoryDone.promise;
    }
    await vi.waitFor(() => expect(harness.stdinDestroyed).toBe(true), {
      interval: 1,
      timeout: 2_000,
    });
    expect(readHarnessMessages(harness.writes).map(({ method }) => method)).not.toContain(
      "thread/start",
    );
    expect(observedFactoryOptions?.onStartedClient).toBeTypeOf("function");
    expect(observedFactoryOptions?.abandonSignal?.aborted).toBe(true);
    expect(observedFactoryOptions?.timeoutMs).toBe(2_500);
    expect(factoryCalls).toBe(1);
  });

  it("clears the shared app-server when cancellation abandons an in-flight thread request", async () => {
    const abortController = new AbortController();
    const { harness, run } = startThreadWithHarness(30_000, abortController.signal);
    const runError = outcome(run);
    await answerInitialize(harness);
    await waitForThreadStart(harness);

    abortController.abort();

    const error = await runError;
    expectStartupError(error, "aborted", "codex app-server startup aborted");
    expect(harness.process.stdin.destroyed).toBe(true);
  });

  it("continues with a deny-all apps patch when plugin discovery exceeds its shared deadline", async () => {
    vi.useFakeTimers();
    const deadlinePluginConfig = {
      appServer: { command: "codex", requestTimeoutMs: 400 },
      codexPlugins: {
        enabled: true,
        plugins: {
          calendar: {
            marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
            pluginName: "calendar",
          },
        },
      },
    } satisfies CodexPluginConfig;
    const { harness, run } = runStartup({
      pluginConfig: deadlinePluginConfig,
    });
    await answerInitialize(harness);
    await waitForRequest(harness, "plugin/installed");
    await vi.advanceTimersByTimeAsync(100);

    const threadStart = await waitForThreadStart(harness);
    const startMessage = readHarnessMessages(harness.writes).find(
      (message) => message.id === threadStart.id,
    ) as { id?: number; params?: { config?: { apps?: unknown } } } | undefined;
    expect(startMessage?.params?.config?.apps).toEqual({
      _default: {
        enabled: false,
        destructive_enabled: false,
        open_world_enabled: false,
      },
    });
    harness.send({ id: threadStart.id, result: threadStartResult() });

    const result = await run;
    releaseAttempt(result);
  });

  it("clears the shared app-server when a startup RPC times out", async () => {
    vi.useFakeTimers();
    const perRpcTimeoutPluginConfig = {
      ...requestConfig(1_000),
      computerUse: { enabled: true, marketplaceDiscoveryTimeoutMs: 1 },
    } satisfies CodexPluginConfig;
    const { harness, run } = runStartup({
      pluginConfig: perRpcTimeoutPluginConfig,
    });
    const runError = outcome(run);
    await answerInitialize(harness);
    await waitForRequest(harness, "plugin/list");
    await vi.advanceTimersByTimeAsync(1_000);

    const error = await runError;
    expect(error).toBeInstanceOf(AgentHarnessPreflightError);
    expect(error).toMatchObject({ scope: "harness" });
    const cause = (error as Error).cause;
    expect(isCodexAppServerRequestTimeoutError(cause)).toBe(true);
    expect((cause as Error).message).toBe("plugin/list timed out");
    expect(harness.process.stdin.destroyed).toBe(true);
  });
});
