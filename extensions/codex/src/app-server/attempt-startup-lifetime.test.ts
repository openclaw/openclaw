import assert from "node:assert/strict";
import { nativeHookRelayTesting as hookRelays } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireInitializedLease,
  setupStartupLifecycle,
} from "./attempt-startup-lifecycle.test-support.js";
import * as startup from "./attempt-startup.test-support.js";
import { CodexAppServerClient } from "./client.js";
import { threadStartResult as createThreadStartResult } from "./codex-app-server.test-fixtures.js";
import { type CodexPluginConfig, resolveCodexAppServerRuntimeOptions } from "./config.js";
import { setCodexTestToolFactory } from "./host-capability.test-support.js";
import { codexNativeSubagentMonitorRuntime as monitor } from "./native-subagent-monitor.js";
import * as resources from "./run-attempt-resources.js";
import * as attempts from "./run-attempt-test-harness.js";
import * as sandbox from "./sandbox-exec-server.js";
import { createSandboxContext } from "./sandbox-exec-server.test-helpers.js";
import { testCodexAppServerBindingStore as bindings } from "./session-binding.test-helpers.js";
import { releaseLeasedSharedCodexAppServerClient } from "./shared-client.js";
import { createInferenceReadyClientHarness } from "./test-support.js";

vi.mock("./desktop-generation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./desktop-generation.js")>()),
  waitForCodexDesktopGeneration: async () => undefined,
}));

const tempRoots = new Set<string>();
const pluginConfig: CodexPluginConfig = { appServer: { command: "codex" } };
const startThreadWithHarness = startup.createAttemptThreadStarter(tempRoots, pluginConfig);
const threadStartResult = (threadId = "thread-1") => createThreadStartResult(threadId, "/repo");
const bindingKey = {
  kind: "session" as const,
  agentId: "agent-1",
  sessionId: "session-1",
  sessionKey: "agent:agent-1:session-1",
};
function sendLateThread(harness: startup.AttemptClientHarness, id: number) {
  const result = threadStartResult("replacement-thread");
  harness.send({ id, result });
  harness.send({ method: "thread/started", params: { thread: result.thread } });
}

describe("startup cancellation with a healthy peer and replacement attempt", () => {
  setupStartupLifecycle(tempRoots);

  it("retires indeterminate thread startup while another leased peer completes", async () => {
    const threadWritten = createDeferred<{ id: number }>();
    const retained = createInferenceReadyClientHarness({
      onWrite: (line, send) => {
        const request = JSON.parse(line) as { id: number; method: string };
        if (request.method === "configRequirements/read") {
          send({ id: request.id, result: { requirements: null } });
        } else if (request.method === "thread/start") {
          threadWritten.resolve(request);
        }
      },
    });
    const replacement = startup.createAttemptClientHarness();
    vi.spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(retained.client)
      .mockResolvedValueOnce(replacement.client);
    const paths = startup.createAttemptPaths(tempRoots);

    await acquireInitializedLease(retained, {
      startOptions: resolveCodexAppServerRuntimeOptions({ pluginConfig }).start,
      agentDir: paths.agentDir,
    });

    const peer = retained.client.request("turn/start", { threadId: "healthy-peer" });
    void peer.catch(() => undefined);
    const peerStart = await startup.waitForRequest(retained, "turn/start");
    // Advance the startup clock only after worker admission writes the request.
    vi.useFakeTimers();
    const startOn = (harness: startup.AttemptClientHarness, timeoutMs: number) =>
      startThreadWithHarness(timeoutMs, undefined, {
        harness,
        paths,
        skipStartSpy: true,
        buildAttemptParams: () => ({ ...startup.createAttemptParams(paths), disableTools: false }),
      }).run;
    const run = startOn(retained, 100);
    const rejected = expect(run).rejects.toThrow("codex app-server startup timed out");
    const threadStart = await threadWritten.promise;
    await vi.advanceTimersByTimeAsync(100);

    await rejected;
    vi.useRealTimers();
    expect(threadStart.id).toBeDefined();
    expect(retained.process.stdin.destroyed).toBe(false);
    const replacementRun = startOn(replacement, 5_000);
    await startup.answerInitialize(replacement);
    const mutate = vi.spyOn(bindings, "mutate");
    sendLateThread(retained, threadStart.id);
    const replacementStart = await startup.waitForThreadStart(replacement);
    expect(mutate).not.toHaveBeenCalled();
    replacement.send({ id: replacementStart.id, result: threadStartResult("replacement-thread") });
    const replacementAttempt = await replacementRun;
    const binding = bindings.read(bindingKey);
    expect(binding?.threadId).toBe("replacement-thread");
    const writesAfterReplacement = mutate.mock.calls.length;
    const tool = vi.fn(() => ({ success: true }));
    await replacementAttempt.turnRoute.activate({ onRequest: tool });
    const toolRequest = {
      method: "item/tool/call",
      params: { threadId: "replacement-thread", turnId: "replacement-turn", tool: "message" },
    };
    sendLateThread(retained, threadStart.id);
    retained.send({ id: "stale-tool", ...toolRequest });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    await replacementAttempt.turnRoute.drain();
    expect(tool).not.toHaveBeenCalled();
    expect(mutate).toHaveBeenCalledTimes(writesAfterReplacement);
    expect(bindings.read(bindingKey)).toEqual(binding);
    for (const forbidden of ["thread/unsubscribe", "turn/start"]) {
      expect(startup.readHarnessRequestMethods(replacement)).not.toContain(forbidden);
    }
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
  attempts.setupRunAttemptTestHooks();
  afterEach(() => clearRuntimeConfigSnapshot());

  it.each(["capture-failed", "abort"] as const)(
    "releases owners once after monitor setup %s",
    async (ending) => {
      const harness = attempts.createStartedThreadHarness();
      const params = attempts.createTestParams();
      setRuntimeConfigSnapshot(params.config ?? {});
      const abortController = new AbortController();
      params.abortSignal = abortController.signal;
      params.sandbox = createSandboxContext({});
      params.runtimePlan = attempts.createCodexRuntimePlanFixture();
      attempts.setCodexTestModelSupportsTools(params, true);
      setCodexTestToolFactory(params, () => [attempts.createRuntimeDynamicTool("message")]);
      const resourcesSpy = vi.spyOn(resources, "prepareCodexAttemptResources");
      const releaseSandbox = vi.spyOn(sandbox, "releaseCodexSandboxExecServerEnvironment");
      const setupError = new Error("native monitor setup failed");
      const captured =
        createDeferred<ReturnType<typeof resources.prepareCodexAttemptResources>["state"]>();
      const releaseCapture = createDeferred<void>();
      const registerMonitor = monitor.register;
      let registration: Awaited<ReturnType<typeof registerMonitor>> | undefined;
      vi.spyOn(monitor, "register").mockImplementationOnce(async (options) => {
        const state = resourcesSpy.mock.results[0]?.value.state;
        assert(
          state?.turnRoute &&
            state.sandboxExecEnvironment &&
            state.nativeHookRelay &&
            state.releaseSharedClientLease,
          "startup must allocate route, sandbox, relay and client lease before monitor setup",
        );
        vi.spyOn(state.turnRoute, "release");
        vi.spyOn(state.nativeHookRelay, "unregister");
        vi.spyOn(state.nativeHookRelay, "drain");
        state.releaseSharedClientLease = vi.fn(state.releaseSharedClientLease);
        const owners = { ...state };
        if (ending !== "capture-failed") {
          registration = await registerMonitor(options);
          vi.spyOn(registration, "unregister");
        }
        captured.resolve(owners);
        await releaseCapture.promise;
        if (!registration) {
          throw setupError;
        }
        return registration;
      });

      try {
        const run = attempts.runCodexAppServerAttempt(params, {
          pluginConfig: { appServer: { mode: "yolo", experimental: { sandboxExecServer: true } } },
          nativeHookRelay: { enabled: true, events: ["pre_tool_use"] },
        });
        const rejected = expect(run).rejects.toBe(setupError);
        const owners = await captured.promise;
        if (ending === "abort") {
          abortController.abort(setupError);
        }
        releaseCapture.resolve();
        await rejected;
        if (registration) {
          expect(registration.unregister).toHaveBeenCalledOnce();
        }
        expect.soft(owners.turnRoute?.release).toHaveBeenCalledOnce();
        expect.soft(owners.releaseSharedClientLease).toHaveBeenCalledOnce();
        expect.soft(owners.nativeHookRelay?.unregister).toHaveBeenCalledOnce();
        expect.soft(owners.nativeHookRelay?.drain).toHaveBeenCalledOnce();
        expect
          .soft(releaseSandbox)
          .toHaveBeenCalledExactlyOnceWith(params.sandbox, owners.sandboxExecEnvironment);
        const relayId = owners.nativeHookRelay!.relayId;
        expect.soft(hookRelays.getNativeHookRelayRegistrationForTests(relayId)).toBeUndefined();
        expect(harness.requests.some((request) => request.method === "turn/start")).toBe(false);
      } finally {
        releaseCapture.resolve();
        harness.close();
      }
    },
  );
});
