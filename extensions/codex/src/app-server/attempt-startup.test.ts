// Codex tests cover attempt startup plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentHarnessPreflightError,
  embeddedAgentLog,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { startCodexAttemptThread } from "./attempt-startup.js";
import {
  answerInitialize,
  captureExpectedRuntimeArtifact,
  createPairedAttemptRuntime,
  createAttemptPaths,
  createAttemptClientHarness,
  createAttemptThreadStarter,
  createAttemptParams,
  type AttemptPaths,
  readHarnessMessages,
  readHarnessRequestMethods,
  waitForRequest,
  waitForThreadStart,
  type AttemptClientHarness as ClientHarness,
} from "./attempt-startup.test-support.js";
import { isCodexAppServerStartupError } from "./attempt-timeouts.js";
import { CodexAppServerClient, isCodexAppServerRequestTimeoutError } from "./client.js";
import { threadStartResult as createThreadStartResult } from "./codex-app-server.test-fixtures.js";
import { type CodexPluginConfig, resolveCodexAppServerRuntimeOptions } from "./config.js";
import { setManagedCodexPluginRoot } from "./managed-binary.js";
import { codexPluginConfig, curatedPlugin } from "./plugin-inventory.test-helpers.js";
import { defaultCodexPluginMetadataCache } from "./plugin-metadata-cache.js";
import { sandboxExecServerRegistry } from "./sandbox-exec-server-registry.js";
import { releaseCodexSandboxExecServerEnvironment } from "./sandbox-exec-server.js";
import { createSandboxContext } from "./sandbox-exec-server.test-helpers.js";
import {
  resetCodexTestBindingStore,
  testCodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";
import {
  clearSharedCodexAppServerClientAndWait,
  createIsolatedCodexAppServerClient,
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
  retainSharedCodexAppServerClientIfCurrent,
  retireSharedCodexAppServerClientIfCurrent,
} from "./shared-client.js";
import { createClientHarness, stubCodexInferenceTransportEnv } from "./test-support.js";
import { createCodexLifecycleHarness } from "./thread-lifecycle.test-fixtures.js";
import { retainCodexAppServerBindingSubscription } from "./thread-ownership.js";

vi.mock("./desktop-generation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./desktop-generation.js")>()),
  waitForCodexDesktopGeneration: async () => undefined,
}));

const tempRoots = new Set<string>();

const pluginConfig: CodexPluginConfig = { appServer: { command: "codex" } };

const startThreadWithHarness = createAttemptThreadStarter(tempRoots, pluginConfig);

const readError = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

async function startIsolatedPairedAttempt(params: {
  harness: ClientHarness;
  sessionId: string;
  runtime: NonNullable<Parameters<typeof startCodexAttemptThread>[0]["runtime"]>;
  paths?: AttemptPaths;
}) {
  const paths = params.paths ?? createAttemptPaths(tempRoots);
  const sandbox = {
    ...createSandboxContext({}),
    backendId: "node",
    backend: undefined,
    fsBridge: undefined,
    runtimeId: `paired-node-${params.sessionId}`,
    placementExecutionMode: "remote-exec" as const,
    placementNodeId: "paired-device-1",
    placementEnvironmentId: `environment-${params.sessionId}`,
    placementSessionId: params.sessionId,
    placementOwnerEpoch: 1,
  };
  const run = startThreadWithHarness(5_000, new AbortController().signal, {
    harness: params.harness,
    paths,
    skipStartSpy: true,
    runtime: params.runtime,
    sandbox,
    attemptClientFactory: () => createIsolatedCodexAppServerClient,
    buildAttemptParams: () => ({
      ...createAttemptParams(paths),
      sessionId: params.sessionId,
      sessionKey: `agent:agent-1:${params.sessionId}`,
    }),
  }).run;
  await answerInitialize(params.harness);
  const environmentAdd = await waitForRequest(params.harness, "environment/add");
  params.harness.send({ id: environmentAdd.id, result: {} });
  const threadStart = await waitForThreadStart(params.harness);
  params.harness.send({ id: threadStart.id, result: threadStartResult(params.sessionId) });
  const result = await run;
  const environmentId = (environmentAdd.params as { environmentId?: string }).environmentId;
  expect(environmentId).toMatch(/^openclaw-node-/u);
  expect(
    readHarnessMessages(params.harness.writes).filter(({ method }) => method === "environment/add"),
  ).toHaveLength(1);
  return { result, sandbox, environmentId };
}

const threadStartResult = (threadId = "thread-1") => createThreadStartResult(threadId, "/repo");

/** Binds the session to a retired owner whose native writer another session's lease keeps alive. */
async function bindToRetiredLeasedOwner() {
  const paths = createAttemptPaths(tempRoots);
  const respond = async (method: string) => {
    if (method === "config/read") {
      return { config: {}, origins: {}, layers: [] };
    }
    if (method === "configRequirements/read") {
      return { requirements: null };
    }
    if (method === "thread/start" || method === "thread/resume") {
      return threadStartResult("bound-thread");
    }
    throw new Error(`unexpected method: ${method}`);
  };
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
  // Keep the native thread loaded: a passive notLoaded read would permit handoff
  // before process exit, even without a thread/closed receipt.
  bound.turnRoute.release();
  bound.releaseSharedClientLease();
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
  return {
    owner,
    healthy,
    start,
    startOn,
    ownerExitCodesAtResume,
    exitWaitStarted: exitWaitStarted.promise,
    releaseOwnerPeer: () => releaseOwnerPeer?.(),
  };
}

describe("startCodexAttemptThread", () => {
  beforeEach(async () => {
    vi.useRealTimers();
    vi.stubEnv("CODEX_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    stubCodexInferenceTransportEnv();
    await clearSharedCodexAppServerClientAndWait();
    // Direct runtime tests supply the plugin root normally owned by loader registration.
    setManagedCodexPluginRoot(fileURLToPath(new URL("../../", import.meta.url)));
    defaultCodexPluginMetadataCache.clear();
    resetCodexTestBindingStore();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await clearSharedCodexAppServerClientAndWait();
    setManagedCodexPluginRoot(undefined);
    defaultCodexPluginMetadataCache.clear();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const root of tempRoots) {
      await fs.rm(root, { recursive: true, force: true });
    }
    tempRoots.clear();
  });

  it.each([true, false])(
    "validates the expected runtime artifact (matching=%s)",
    async (matching) => {
      const paths = createAttemptPaths(tempRoots);
      await fs.mkdir(paths.workspaceDir, { recursive: true });
      const command = path.join(paths.workspaceDir, "codex-runtime");
      await fs.writeFile(command, "native-v1");
      const configuredPlugin: CodexPluginConfig = { appServer: { command } };
      const expected = matching
        ? await captureExpectedRuntimeArtifact(
            resolveCodexAppServerRuntimeOptions({ pluginConfig: configuredPlugin }),
          )
        : { id: "codex-app-server:v1:wrong", fingerprint: "0".repeat(64) };
      const harness = createAttemptClientHarness();
      const { run } = startThreadWithHarness(5_000, new AbortController().signal, {
        harness,
        paths,
        pluginConfig: configuredPlugin,
        runtimeArtifactRequest: { expected },
      });
      if (!matching) {
        await expect(run).rejects.toThrow("does not match verified inference");
        expect(harness.writes).toEqual([]);
        return;
      }
      await answerInitialize(harness);
      const threadStart = await waitForThreadStart(harness);
      harness.send({ id: threadStart.id, result: threadStartResult() });
      const result = await run;

      expect(result.runtimeArtifact).toEqual(expected);
      result.turnRoute.release();
      result.releaseSharedClientLease();
    },
  );

  it("retires a failed startup client after another active lease releases", async () => {
    const retained = createAttemptClientHarness();
    const replacement = createAttemptClientHarness();
    const startSpy = vi
      .spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(retained.client)
      .mockResolvedValueOnce(replacement.client);
    const appServer = resolveCodexAppServerRuntimeOptions({ pluginConfig });
    const paths = createAttemptPaths(tempRoots);

    const retainedLease = getLeasedSharedCodexAppServerClient({
      startOptions: appServer.start,
      agentDir: paths.agentDir,
    });
    await answerInitialize(retained);
    await expect(retainedLease).resolves.toBe(retained.client);

    const { run } = startThreadWithHarness(5_000, new AbortController().signal, {
      harness: retained,
      paths,
      skipStartSpy: true,
    });
    const threadStart = await waitForThreadStart(retained);
    retained.send({
      id: threadStart.id,
      error: { code: -32000, message: "401 authentication_error: Invalid bearer token" },
    });

    await expect(run).rejects.toThrow("Invalid bearer token");
    expect(retained.process.stdin.destroyed).toBe(false);

    expect(releaseLeasedSharedCodexAppServerClient(retained.client)).toBe(true);
    await vi.waitFor(() => expect(retained.process.stdin.destroyed).toBe(true));

    const replacementLease = getLeasedSharedCodexAppServerClient({
      startOptions: appServer.start,
      agentDir: paths.agentDir,
    });
    await answerInitialize(replacement);
    await expect(replacementLease).resolves.toBe(replacement.client);
    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(releaseLeasedSharedCodexAppServerClient(replacement.client)).toBe(true);
  });

  it("preserves the healthy shared client and incognito history after a prewrite resume refusal", async () => {
    const paths = createAttemptPaths(tempRoots);
    const harness = createCodexLifecycleHarness({
      respond: async (method, params) => {
        if (method === "config/read") {
          return { config: {}, origins: {}, layers: [] };
        }
        if (method === "configRequirements/read") {
          return { requirements: null };
        }
        if (method === "thread/start") {
          return threadStartResult(
            (params as { ephemeral?: boolean }).ephemeral ? "incognito" : "ordinary",
          );
        }
        throw new Error(`unexpected method: ${method}`);
      },
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
    ordinary.turnRoute.release();
    ordinary.releaseSharedClientLease();
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
    previous.turnRoute.release();
    previous.releaseSharedClientLease();

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
    continued.turnRoute.release();
    continued.releaseSharedClientLease();
  });

  it("keeps the healthy startup client when a stop ends its wait for a retired owner's exit", async () => {
    const fixture = await bindToRetiredLeasedOwner();
    const stop = new AbortController();
    const stopped = readError(fixture.startOn(fixture.healthy, stop.signal));
    await fixture.exitWaitStarted;
    stop.abort();

    // The stop settles while another lease still keeps the owner's native writer alive.
    expect(isCodexAppServerStartupError(await stopped, "aborted")).toBe(true);
    expect(fixture.owner.process.exitCode).toBeNull();
    expect(readHarnessRequestMethods(fixture.healthy)).not.toContain("thread/resume");
    expect(fixture.healthy.stdinDestroyed).toBe(false);

    const successor = fixture.startOn(fixture.healthy);
    fixture.releaseOwnerPeer();
    const resumed = await successor;
    // The successor reuses the same client and writes only after the owner exits.
    expect(resumed.client).toBe(fixture.healthy.client);
    expect(resumed.thread.threadId).toBe("bound-thread");
    expect(fixture.ownerExitCodesAtResume).toEqual([0]);
    expect(fixture.start).toHaveBeenCalledTimes(2);
    expect(fixture.healthy.stdinDestroyed).toBe(false);
    resumed.turnRoute.release();
    resumed.releaseSharedClientLease();
  });

  it("retires the startup client when its deadline ends a wait for a retired owner's exit", async () => {
    const fixture = await bindToRetiredLeasedOwner();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const timedOut = readError(fixture.startOn(fixture.healthy, undefined, 1_000));
    await fixture.exitWaitStarted;
    await vi.advanceTimersByTimeAsync(1_000);

    expect(isCodexAppServerStartupError(await timedOut, "timed_out")).toBe(true);
    expect(fixture.healthy.stdinDestroyed).toBe(true);
    expect(fixture.owner.process.exitCode).toBeNull();
    expect(readHarnessRequestMethods(fixture.healthy)).not.toContain("thread/resume");
    fixture.releaseOwnerPeer();
  });

  it.each([
    {
      method: "initialize",
      stage: "client-acquire",
      loggerThrows: false,
    },
    {
      method: "thread/start",
      stage: "thread-lifecycle",
      loggerThrows: true,
    },
  ])(
    "records the blocked $method before timeout cleanup (logger throws=$loggerThrows)",
    async (blocked) => {
      // Keep transport exit and worker I/O live while the startup clock is frozen.
      vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
      const harness = createAttemptClientHarness();
      const paths = createAttemptPaths(tempRoots);
      const attemptParams = createAttemptParams(paths);
      const timeoutWarnings: { metadata: unknown; transportClosed: boolean }[] = [];
      vi.spyOn(embeddedAgentLog, "warn").mockImplementation((message, metadata) => {
        if (message === "codex app-server startup timed out") {
          timeoutWarnings.push({ metadata, transportClosed: harness.stdinDestroyed });
          if (blocked.loggerThrows) {
            throw new Error("diagnostic logger failed");
          }
        }
      });
      const { run } = startThreadWithHarness(500, undefined, {
        harness,
        paths,
        buildAttemptParams: () => attemptParams,
      });
      const runError = readError(run);
      if (blocked.method !== "initialize") {
        await answerInitialize(harness);
      }
      for (let index = 0; ; index += 1) {
        const [request] = readHarnessMessages([await harness.waitForWrite(index)]);
        if (request?.method === blocked.method) {
          break;
        }
      }
      await vi.advanceTimersByTimeAsync(500);

      const error = await runError;
      if (blocked.method !== "initialize") {
        await vi.waitFor(() => expect(harness.stdinDestroyed).toBe(true), {
          interval: 1,
          timeout: 1_000,
        });
      }
      expect(error).toBeInstanceOf(Error);
      expect(isCodexAppServerStartupError(error, "timed_out")).toBe(true);
      expect((error as Error).message).toBe("codex app-server startup timed out");
      expect(harness.stdinDestroyed).toBe(blocked.method !== "initialize");
      expect(timeoutWarnings).toEqual([
        {
          transportClosed: false,
          metadata: expect.objectContaining({
            runId: attemptParams.runId,
            sessionId: attemptParams.sessionId,
            stage: blocked.stage,
            clientInstanceId: harness.client.getInstanceId(),
            clientPendingRequestMethods: [blocked.method],
            elapsedMs: 500,
            timeoutMs: 500,
          }),
        },
      ]);
      expect(JSON.stringify(timeoutWarnings)).not.toContain(paths.workspaceDir);
    },
  );

  it("bounds initialize and closes the transport with stderr=true", async () => {
    // Transport exit uses setImmediate; advance the deadline without freezing its delivery.
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    const harness = createClientHarness({ autoEmitExit: false });
    try {
      const kill = vi.spyOn(harness.process, "kill").mockImplementation((signal) => {
        if (signal === "SIGKILL") {
          harness.process.emit("exit", null, signal);
        }
      });
      // Retain the original subprocess test's budgets for the fixture that refuses EOF.
      const requestTimeoutMs = 2_000;
      const initializeTimeoutPluginConfig = {
        ...pluginConfig,
        appServer: { command: "codex", requestTimeoutMs },
      } satisfies CodexPluginConfig;
      const { run } = startThreadWithHarness(5_000, new AbortController().signal, {
        harness,
        pluginConfig: initializeTimeoutPluginConfig,
        attemptClientFactory: () => createIsolatedCodexAppServerClient,
      });
      const runError = readError(run);

      const initialize = JSON.parse(await harness.waitForWrite(0)) as {
        id?: number;
        method?: string;
      };
      expect(initialize).toMatchObject({ id: expect.any(Number), method: "initialize" });
      harness.process.stderr.write(
        "Error: failed to initialize sqlite state runtime token=secret-value\n",
      );
      await vi.advanceTimersByTimeAsync(requestTimeoutMs);
      expect(harness.stdinDestroyed).toBe(true);
      expect(harness.process.exitCode).toBeNull();
      expect(harness.process.signalCode).toBeNull();
      expect(kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");

      const error = await runError;
      expect(error).toBeInstanceOf(Error);
      expect(isCodexAppServerStartupError(error, "timed_out")).toBe(true);
      expect((error as Error).message).toBe(
        'codex app-server initialize timed out; stderr="Error: failed to initialize sqlite state runtime token=<redacted>"',
      );
      expect(harness.stdinDestroyed).toBe(true);
      expect(harness.process.exitCode).toBe(null);
      expect(harness.process.signalCode).toBe("SIGKILL");
      expect(readHarnessRequestMethods(harness)).toEqual(["initialize"]);
    } finally {
      harness.emitExit();
    }
  });

  it("does not retire shared startup when this attempt's initialize wait expires", async () => {
    vi.useFakeTimers();
    const sharedInitializePluginConfig = {
      ...pluginConfig,
      appServer: { command: "codex", requestTimeoutMs: 1_000 },
    } satisfies CodexPluginConfig;
    const appServer = resolveCodexAppServerRuntimeOptions({
      pluginConfig: sharedInitializePluginConfig,
    });
    const paths = createAttemptPaths(tempRoots);
    const { harness, run, startSpy } = startThreadWithHarness(3_000, new AbortController().signal, {
      pluginConfig: sharedInitializePluginConfig,
      paths,
    });
    await waitForRequest(harness, "initialize");
    const peerStarted = createDeferred<void>();
    const peerAcquire = getLeasedSharedCodexAppServerClient({
      startOptions: appServer.start,
      agentDir: paths.agentDir,
      timeoutMs: 3_000,
      onStartedClient: () => peerStarted.resolve(),
    });
    await peerStarted.promise;

    const rejected = expect(run).rejects.toThrow("codex app-server initialize timed out");
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
    expect(harness.stdinDestroyed).toBe(false);
    await answerInitialize(harness);
    await expect(peerAcquire).resolves.toBe(harness.client);
    await expect(
      getLeasedSharedCodexAppServerClient({
        startOptions: appServer.start,
        agentDir: paths.agentDir,
        timeoutMs: 3_000,
      }),
    ).resolves.toBe(harness.client);
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(releaseLeasedSharedCodexAppServerClient(harness.client)).toBe(true);
    expect(releaseLeasedSharedCodexAppServerClient(harness.client)).toBe(true);
  });

  it.each(["acquire timeout", "startup timeout", "abort"] as const)(
    "preserves sole-waiter shared startup after %s",
    async (abandonment) => {
      vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
      const paths = createAttemptPaths(tempRoots);
      const controller = new AbortController();
      const sharedConfig = { appServer: { command: "codex", requestTimeoutMs: 1_000 } };
      const { harness, run, startSpy } = startThreadWithHarness(
        abandonment === "startup timeout" ? 500 : 3_000,
        controller.signal,
        { paths, pluginConfig: sharedConfig },
      );
      const rejected = expect(run).rejects.toThrow(
        abandonment === "acquire timeout"
          ? "codex app-server initialize timed out"
          : abandonment === "startup timeout"
            ? "codex app-server startup timed out"
            : "codex app-server startup aborted",
      );
      const initialize = JSON.parse(await harness.waitForWrite(0)) as { id: number };
      if (abandonment === "abort") {
        controller.abort();
      } else {
        await vi.advanceTimersByTimeAsync(abandonment === "startup timeout" ? 500 : 1_000);
      }
      await rejected;
      expect(harness.stdinDestroyed).toBe(false);
      const laterAcquire = getLeasedSharedCodexAppServerClient({
        startOptions: resolveCodexAppServerRuntimeOptions({ pluginConfig: sharedConfig }).start,
        agentDir: paths.agentDir,
        pluginConfig: sharedConfig,
        timeoutMs: 3_000,
      });
      harness.send({ id: initialize.id, result: { userAgent: "openclaw/0.149.0 (macOS; test)" } });
      await expect(laterAcquire).resolves.toBe(harness.client);
      expect(startSpy).toHaveBeenCalledTimes(1);
      expect(readHarnessRequestMethods(harness)).not.toContain("thread/start");
      expect(releaseLeasedSharedCodexAppServerClient(harness.client)).toBe(true);
    },
  );

  it("cleans up a client surfaced by a factory that later rejects", async () => {
    const { harness, run } = startThreadWithHarness(5_000, new AbortController().signal, {
      attemptClientFactory: (factoryHarness) => async (options) => {
        options?.onStartedClient?.(factoryHarness.client);
        throw new Error("custom initialize failed");
      },
    });

    await expect(run).rejects.toThrow("custom initialize failed");
    expect(harness.stdinDestroyed).toBe(true);
  });

  it("closes each paired-node environment and client without interrupting an overlapping sibling", async () => {
    const first = createAttemptClientHarness();
    const second = createAttemptClientHarness();
    const runtime = createPairedAttemptRuntime();
    const firstPaths = createAttemptPaths(tempRoots);
    const secondPaths = createAttemptPaths(tempRoots);
    const start = vi.spyOn(CodexAppServerClient, "start").mockImplementation(async (options) => {
      const codexHome = options?.env?.CODEX_HOME;
      if (codexHome?.startsWith(`${firstPaths.agentDir}${path.sep}`)) {
        return first.client;
      }
      if (codexHome?.startsWith(`${secondPaths.agentDir}${path.sep}`)) {
        return second.client;
      }
      throw new Error(`Unexpected isolated Codex home: ${codexHome}`);
    });
    const [firstAttempt, secondAttempt] = await Promise.all([
      startIsolatedPairedAttempt({
        harness: first,
        sessionId: "overlap-1",
        runtime: runtime.runtime,
        paths: firstPaths,
      }),
      startIsolatedPairedAttempt({
        harness: second,
        sessionId: "overlap-2",
        runtime: runtime.runtime,
        paths: secondPaths,
      }),
    ]);

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
    const { harness, run } = startThreadWithHarness(5_000, new AbortController().signal, {
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
    expect(
      readHarnessMessages(harness.writes).some((entry) => entry.method === "thread/start"),
    ).toBe(false);
  });

  it("closes a startup client that arrives after startup timeout", async () => {
    vi.useFakeTimers();
    let observedFactoryOptions:
      | {
          onStartedClient?: (client: CodexAppServerClient) => void;
          abandonSignal?: AbortSignal;
          timeoutMs?: number;
        }
      | undefined;
    let factoryCalls = 0;
    const factoryDone = createDeferred<void>();
    const factoryRelease = createDeferred<void>();
    const delayedFactoryPluginConfig = {
      ...pluginConfig,
      appServer: { command: "codex", requestTimeoutMs: 2_500 },
    } satisfies CodexPluginConfig;
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
    expect(
      readHarnessMessages(harness.writes).some((write) => write.method === "thread/start"),
    ).toBe(false);
    expect(observedFactoryOptions?.onStartedClient).toBeTypeOf("function");
    expect(observedFactoryOptions?.abandonSignal?.aborted).toBe(true);
    expect(observedFactoryOptions?.timeoutMs).toBe(2_500);
    expect(factoryCalls).toBe(1);
  });

  it("clears the shared app-server when cancellation abandons an in-flight thread request", async () => {
    const abortController = new AbortController();
    const { harness, run } = startThreadWithHarness(30_000, abortController.signal);
    const runError = readError(run);
    await answerInitialize(harness);
    await waitForThreadStart(harness);

    abortController.abort();

    const error = await runError;
    expect(error).toBeInstanceOf(Error);
    expect(isCodexAppServerStartupError(error, "aborted")).toBe(true);
    expect((error as Error).message).toBe("codex app-server startup aborted");
    expect(harness.process.stdin.destroyed).toBe(true);
  });

  it("continues with a deny-all apps patch when plugin discovery exceeds its shared deadline", async () => {
    vi.useFakeTimers();
    const deadlinePluginConfig = {
      appServer: { command: "codex", requestTimeoutMs: 400 },
      ...codexPluginConfig({ plugins: { calendar: curatedPlugin("calendar") } }),
    } satisfies CodexPluginConfig;
    const { harness, run } = startThreadWithHarness(5_000, new AbortController().signal, {
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
    result.turnRoute.release();
    result.releaseSharedClientLease();
  });

  it("clears the shared app-server when a startup RPC times out", async () => {
    vi.useFakeTimers();
    const perRpcTimeoutPluginConfig = {
      ...pluginConfig,
      appServer: { command: "codex", requestTimeoutMs: 1_000 },
      computerUse: { enabled: true, marketplaceDiscoveryTimeoutMs: 1 },
    } satisfies CodexPluginConfig;
    const { harness, run } = startThreadWithHarness(5_000, new AbortController().signal, {
      pluginConfig: perRpcTimeoutPluginConfig,
    });
    const runError = readError(run);
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
