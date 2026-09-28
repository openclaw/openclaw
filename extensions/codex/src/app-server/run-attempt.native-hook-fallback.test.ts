import { Server } from "node:http";
import path from "node:path";
import {
  invokeNativeHookRelay,
  nativeHookRelayTesting,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { setCodexTestToolFactory } from "./host-capability.test-support.js";
import { CODEX_INFERENCE_GENERATION_KEY } from "./inference-metadata.js";
import {
  getCodexInferenceThread,
  getCodexInferenceThreadQualification,
  ownCodexInferenceClient,
} from "./inference-routing.js";
import { nativeHookRelayUnregisterQueue } from "./native-hook-relay-state.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import {
  bindProductionHarnessHostCapabilitiesForTest,
  createParams,
  createRuntimeDynamicTool,
  createStartedThreadHarness,
  extractGenerationFromThreadRequest,
  extractRelayIdFromThreadRequest,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
} from "./run-attempt-test-harness.js";
import { writeCodexAppServerBinding } from "./session-binding.test-helpers.js";
import * as threadLifecyclePreflight from "./thread-lifecycle-preflight.js";

setupRunAttemptTestHooks();

describe("Codex native hook Gateway fallback", () => {
  it("guards native spawn through default optional model admission", async () => {
    const preflight = vi.spyOn(threadLifecyclePreflight, "prepareCodexThreadLifecyclePreflight");
    const params = createParams(
      path.join(tempDir, "optional-participant-hooks.jsonl"),
      path.join(tempDir, "optional-participant-hooks-workspace"),
    );
    const closeHost = await bindProductionHarnessHostCapabilitiesForTest(params, {
      profileId: "unrestricted-native-operator",
      scopes: ["operator.write"],
      assertCurrent: () => {},
    });
    let ambiguous = false;
    params.hostCapabilities = {
      ...params.hostCapabilities,
      assertNativeSubagentSpawnAllowed: () => {
        if (ambiguous) {
          throw new Error("Several people have steered this turn");
        }
      },
    };
    const started = createDeferred<void>();
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "account/read") {
        return { account: { type: "apiKey" } };
      }
      if (method === "turn/start") {
        started.resolve();
      }
      return undefined;
    });
    ownCodexInferenceClient(harness.client);
    const abort = new AbortController();
    params.abortSignal = abort.signal;
    const run = runCodexAppServerAttempt(params);
    try {
      await Promise.race([started.promise, run]);
      expect(preflight).toHaveBeenCalledWith(
        expect.objectContaining({ nativeModelAdmission: "optional" }),
      );
      const start = harness.requests.find(({ method }) => method === "thread/start");
      const relayId = extractRelayIdFromThreadRequest(start?.params);
      const generation = extractGenerationFromThreadRequest(start?.params);
      const spawn = (toolUseId: string) =>
        invokeNativeHookRelay({
          provider: "codex",
          relayId,
          generation,
          requireGeneration: true,
          event: "pre_tool_use",
          rawPayload: {
            session_id: "thread-1",
            turn_id: "turn-1",
            tool_name: "Agent",
            tool_use_id: toolUseId,
            tool_input: { message: "Inspect the fixture" },
          },
        });
      await expect(spawn("single-person")).resolves.toMatchObject({ stdout: "", exitCode: 0 });
      ambiguous = true;
      const response = await spawn("several-people");
      expect(response.stdout).toContain(
        "Use sessions_spawn with the requester's requester_profile.id as user",
      );
      expect(JSON.parse(response.stdout)).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });
      expect(start?.params).not.toHaveProperty(["config", "agents.enabled"], false);
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await run;
    } finally {
      abort.abort("test cleanup");
      await run.catch(() => undefined);
      closeHost();
      harness.close();
    }
  });

  it("preserves a no-policy operator's disabled hooks until a policy is introduced", async () => {
    const params = createParams(
      path.join(tempDir, "optional-model-hooks.jsonl"),
      path.join(tempDir, "optional-model-hooks-workspace"),
    );
    setCodexTestModelSupportsTools(params, true);
    setCodexTestToolFactory(params, () => [createRuntimeDynamicTool("sessions_spawn")]);
    const listeners = new Set<() => void>();
    let policy: NonNullable<
      Parameters<typeof bindProductionHarnessHostCapabilitiesForTest>[1]
    >["modelPolicy"];
    const closeHost = await bindProductionHarnessHostCapabilitiesForTest(params, {
      profileId: "unrestricted-native-operator",
      scopes: ["operator.write"],
      assertCurrent: () => {},
      get modelPolicy() {
        return policy;
      },
      onModelPolicyChanged: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    });
    params.hostCapabilities = {
      ...params.hostCapabilities,
      assertNativeSubagentSpawnAllowed: () => {},
    };
    const selected = { provider: params.provider, model: params.modelId };
    const permitted = params.hostCapabilities.bindModelExecution?.(selected);
    if (!permitted) {
      throw new Error("Expected a canonical operator model guard");
    }
    const started = createDeferred<void>();
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "configRequirements/read") {
        return { requirements: { allowManagedHooksOnly: false } };
      }
      if (method === "account/read") {
        return { account: { type: "apiKey" } };
      }
      if (method === "turn/start") {
        started.resolve();
      }
      return undefined;
    });
    ownCodexInferenceClient(harness.client);
    const abort = new AbortController();
    params.abortSignal = abort.signal;
    const run = runCodexAppServerAttempt(params, {
      nativeHookRelay: { enabled: false },
    });
    try {
      await Promise.race([started.promise, run]);
      const accepted = await codexNativeSubagentMonitorRuntime.captureModelSource({
        client: harness.client,
        threadId: "thread-1",
        turnId: "turn-1",
      });
      expect(accepted).toBeDefined();
      accepted?.release();
      const route = getCodexInferenceThread(harness.client, "thread-1");
      expect(route).toBeDefined();
      expect(getCodexInferenceThreadQualification(harness.client, "thread-1")).toBeUndefined();
      const start = harness.requests.find(({ method }) => method === "thread/start");
      expect(start?.params).toMatchObject({
        config: {
          "features.shell_tool": true,
          openai_base_url: route?.baseUrl,
          "agents.enabled": false,
          "features.multi_agent": false,
          "features.multi_agent_v2": false,
        },
      });
      expect(start?.params).toHaveProperty(
        "dynamicTools",
        expect.arrayContaining([
          expect.objectContaining({ type: "function", name: "sessions_spawn" }),
        ]),
      );
      expect(start?.params).not.toHaveProperty(["config", "hooks.PreToolUse", 0]);
      const turn = harness.requests.find(({ method }) => method === "turn/start");
      expect(turn?.params).toHaveProperty(
        ["responsesapiClientMetadata", CODEX_INFERENCE_GENERATION_KEY],
        expect.any(String),
      );
      policy = {
        models: [selected],
        allows: (model) => model.provider === selected.provider && model.model === selected.model,
      };
      for (const changed of listeners) {
        changed();
      }
      const result = await run;
      expect(readAttemptTerminal(result).aborted).toBe(true);
      expect(harness.requests).toContainEqual({
        method: "turn/interrupt",
        params: { threadId: "thread-1", turnId: "turn-1" },
      });
      expect(permitted.signal.aborted).toBe(false);
      expect(permitted.assertCurrent).not.toThrow();
    } finally {
      abort.abort("test cleanup");
      await run.catch(() => undefined);
      permitted.release();
      closeHost();
      harness.close();
    }
    expect(listeners.size).toBe(0);
  });

  it("keeps resumed native hook policy available when the direct listener fails", async () => {
    const sessionFile = path.join(tempDir, "listener-unavailable.jsonl");
    const workspaceDir = path.join(tempDir, "listener-unavailable-workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
      webSearchThreadConfigFingerprint: JSON.stringify({
        "features.standalone_web_search": false,
        web_search: "disabled",
      }),
    });
    const started = createDeferred<void>();
    const harness = createStartedThreadHarness(
      async (method) => {
        if (method === "thread/resume") {
          return threadStartResult("thread-existing");
        }
        if (method === "turn/start") {
          started.resolve();
        }
        return undefined;
      },
      { persistedThreads: ["thread-existing"] },
    );
    const beforeToolCall = vi.fn(() => ({ block: true, blockReason: "fixture policy denial" }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
    );
    const params = createParams(sessionFile, workspaceDir);
    params.config = { tools: { loopDetection: { enabled: true } } };
    const closeHost = await bindProductionHarnessHostCapabilitiesForTest(params);
    const abort = new AbortController();
    params.abortSignal = abort.signal;
    vi.spyOn(Server.prototype, "listen").mockImplementationOnce(function (this: Server) {
      queueMicrotask(() =>
        this.emit(
          "error",
          Object.assign(new Error("fixture listener unavailable"), { code: "EADDRNOTAVAIL" }),
        ),
      );
      return this;
    });
    const run = runCodexAppServerAttempt(params, {
      nativeHookRelay: { enabled: true, events: ["pre_tool_use"] },
    });
    try {
      await Promise.race([started.promise, run.then(() => undefined)]);
      const request = harness.requests.find(({ method }) => method === "thread/resume");
      const relayId = extractRelayIdFromThreadRequest(request?.params);
      const generation = extractGenerationFromThreadRequest(request?.params);
      const response = await invokeNativeHookRelay({
        provider: "codex",
        relayId,
        generation,
        requireGeneration: true,
        event: "pre_tool_use",
        rawPayload: {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_use_id: "listener-unavailable-tool",
          tool_input: { command: "pwd" },
        },
      });
      expect(response.stdout).toContain("fixture policy denial");
      expect(beforeToolCall).toHaveBeenCalledTimes(1);
      await harness.completeTurn({
        threadId: "thread-existing",
        turnId: "turn-1",
      });
      await run;
      await nativeHookRelayUnregisterQueue.flush();
      expect(
        nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId),
      ).toBeUndefined();
    } finally {
      abort.abort("test cleanup");
      await Promise.allSettled([run]);
      closeHost();
    }
  });
});
