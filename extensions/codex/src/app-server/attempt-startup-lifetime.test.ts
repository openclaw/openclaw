import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { nativeHookRelayTesting } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  answerInitialize,
  createAttemptPaths,
  createAttemptClientHarness,
  createAttemptThreadStarter,
  readHarnessRequestMethods,
  waitForRequest,
  waitForThreadStart,
} from "./attempt-startup.test-support.js";
import { CodexAppServerClient } from "./client.js";
import { threadStartResult as createThreadStartResult } from "./codex-app-server.test-fixtures.js";
import { type CodexPluginConfig, resolveCodexAppServerRuntimeOptions } from "./config.js";
import { setCodexTestToolFactory } from "./host-capability.test-support.js";
import { setManagedCodexPluginRoot } from "./managed-binary.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import { defaultCodexPluginMetadataCache } from "./plugin-metadata-cache.js";
import * as runAttemptResources from "./run-attempt-resources.js";
import {
  createCodexRuntimePlanFixture,
  createRuntimeDynamicTool,
  createStartedThreadHarness,
  createTestParams,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
} from "./run-attempt-test-harness.js";
import * as sandboxExecServer from "./sandbox-exec-server.js";
import { createSandboxContext } from "./sandbox-exec-server.test-helpers.js";
import {
  resetCodexTestBindingStore,
  testCodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";
import {
  clearSharedCodexAppServerClientAndWait,
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
} from "./shared-client.js";

vi.mock("./desktop-generation.js", () => ({
  isCodexDesktopGenerationCurrent: () => false,
  waitForCodexDesktopGeneration: async () => undefined,
}));

const tempRoots = new Set<string>();
const pluginConfig: CodexPluginConfig = { appServer: { command: "codex" } };
const startThreadWithHarness = createAttemptThreadStarter(tempRoots, pluginConfig);
const threadStartResult = (threadId = "thread-1") => createThreadStartResult(threadId, "/repo");

describe("startup cancellation with a healthy peer and replacement attempt", () => {
  beforeEach(async () => {
    vi.stubEnv("CODEX_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    await clearSharedCodexAppServerClientAndWait();
    setManagedCodexPluginRoot(fileURLToPath(new URL("../../", import.meta.url)));
    defaultCodexPluginMetadataCache.clear();
    resetCodexTestBindingStore();
  });

  afterEach(async () => {
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

  it("retires indeterminate thread startup while another leased peer completes", async () => {
    const retained = createAttemptClientHarness();
    const replacement = createAttemptClientHarness();
    vi.spyOn(CodexAppServerClient, "start")
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

    const peer = retained.client.request("turn/start", { threadId: "healthy-peer" });
    const peerStart = await waitForRequest(retained, "turn/start");
    const { run } = startThreadWithHarness(100, new AbortController().signal, {
      harness: retained,
      paths,
      skipStartSpy: true,
    });
    const rejected = expect(run).rejects.toThrow("codex app-server startup timed out");
    const threadStart = await waitForThreadStart(retained);

    await rejected;
    expect(threadStart.id).toBeDefined();
    expect(retained.process.stdin.destroyed).toBe(false);
    const replacementRun = startThreadWithHarness(5_000, new AbortController().signal, {
      harness: replacement,
      paths,
      skipStartSpy: true,
    }).run;
    await answerInitialize(replacement);
    const mutate = vi.spyOn(testCodexAppServerBindingStore, "mutate");
    retained.send({ id: threadStart.id, result: threadStartResult("replacement-thread") });
    retained.send({
      method: "thread/started",
      params: { thread: threadStartResult("replacement-thread").thread },
    });
    const replacementStart = await waitForThreadStart(replacement);
    expect(mutate).not.toHaveBeenCalled();
    replacement.send({ id: replacementStart.id, result: threadStartResult("replacement-thread") });
    const replacementAttempt = await replacementRun;
    const binding = testCodexAppServerBindingStore.read({
      kind: "session",
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:agent-1:session-1",
    });
    expect(binding?.threadId).toBe("replacement-thread");
    const writesAfterReplacement = mutate.mock.calls.length;
    const tool = vi.fn(() => ({ success: true }));
    await replacementAttempt.turnRoute.activate({ onRequest: tool });
    const toolRequest = {
      method: "item/tool/call",
      params: { threadId: "replacement-thread", turnId: "replacement-turn", tool: "message" },
    };
    retained.send({ id: threadStart.id, result: threadStartResult("replacement-thread") });
    retained.send({
      method: "thread/started",
      params: { thread: threadStartResult("replacement-thread").thread },
    });
    retained.send({ id: "stale-tool", ...toolRequest });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    await replacementAttempt.turnRoute.drain();
    expect(tool).not.toHaveBeenCalled();
    expect(mutate).toHaveBeenCalledTimes(writesAfterReplacement);
    expect(
      testCodexAppServerBindingStore.read({
        kind: "session",
        agentId: "agent-1",
        sessionId: "session-1",
        sessionKey: "agent:agent-1:session-1",
      }),
    ).toEqual(binding);
    expect(readHarnessRequestMethods(replacement)).not.toContain("thread/unsubscribe");
    expect(readHarnessRequestMethods(replacement)).not.toContain("turn/start");
    // Positive route control: only the authoritative client's tool request runs.
    replacement.send({ id: "current-tool", ...toolRequest });
    await vi.waitFor(() => expect(tool).toHaveBeenCalledTimes(1));
    retained.send({ id: peerStart.id, result: { turn: { id: "healthy-turn" } } });
    await expect(peer).resolves.toEqual({ turn: { id: "healthy-turn" } });
    expect(retained.process.stdin.destroyed).toBe(false);
    expect(releaseLeasedSharedCodexAppServerClient(retained.client)).toBe(true);
    expect(retained.process.stdin.destroyed).toBe(true);
    expect(replacement.process.stdin.destroyed).toBe(false);
    replacementAttempt.turnRoute.release();
    replacementAttempt.releaseSharedClientLease();
  });
});

describe("Codex runtime startup resource lifetime", () => {
  setupRunAttemptTestHooks();

  it("releases allocated runtime owners once when native monitor setup fails", async () => {
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    params.sandbox = createSandboxContext({});
    params.runtimePlan = createCodexRuntimePlanFixture();
    setCodexTestModelSupportsTools(params, true);
    setCodexTestToolFactory(params, () => [createRuntimeDynamicTool("message")]);
    const resourcesSpy = vi.spyOn(runAttemptResources, "prepareCodexAttemptResources");
    const releaseSandbox = vi.spyOn(sandboxExecServer, "releaseCodexSandboxExecServerEnvironment");
    const allocated: Array<
      ReturnType<typeof runAttemptResources.prepareCodexAttemptResources>["state"]
    > = [];
    const setupError = new Error("native monitor setup failed");
    const register = vi
      .spyOn(codexNativeSubagentMonitorRuntime, "register")
      .mockImplementationOnce(() => {
        const state = resourcesSpy.mock.results[0]?.value.state;
        assert(state?.turnRoute, "startup must allocate a route before monitor setup");
        assert(
          state.sandboxExecEnvironment,
          "startup must allocate a sandbox before monitor setup",
        );
        assert(state.nativeHookRelay, "startup must allocate a relay before monitor setup");
        assert(
          state.releaseSharedClientLease,
          "startup must allocate a client lease before monitor setup",
        );
        vi.spyOn(state.turnRoute, "release");
        vi.spyOn(state.nativeHookRelay, "unregister");
        vi.spyOn(state.nativeHookRelay, "drain");
        state.releaseSharedClientLease = vi.fn(state.releaseSharedClientLease);
        allocated.push({ ...state });
        throw setupError;
      });

    try {
      await expect(
        runCodexAppServerAttempt(params, {
          pluginConfig: { appServer: { mode: "yolo", experimental: { sandboxExecServer: true } } },
          nativeHookRelay: { enabled: true, events: ["pre_tool_use"] },
        }),
      ).rejects.toBe(setupError);
      expect(register).toHaveBeenCalledOnce();
      const [owners] = allocated;
      assert(owners);
      expect.soft(owners.turnRoute?.release).toHaveBeenCalledOnce();
      expect.soft(owners.releaseSharedClientLease).toHaveBeenCalledOnce();
      expect.soft(owners.nativeHookRelay?.unregister).toHaveBeenCalledOnce();
      expect.soft(owners.nativeHookRelay?.drain).toHaveBeenCalledOnce();
      expect
        .soft(releaseSandbox)
        .toHaveBeenCalledExactlyOnceWith(params.sandbox, owners.sandboxExecEnvironment);
      expect
        .soft(
          nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(
            owners.nativeHookRelay!.relayId,
          ),
        )
        .toBeUndefined();
      expect(harness.requests.some((request) => request.method === "turn/start")).toBe(false);
    } finally {
      harness.close();
    }
  });
});
