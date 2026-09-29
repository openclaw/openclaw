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
import { createCodexTestHostCapabilities } from "./host-capability.test-support.js";
import {
  getCodexInferenceThread,
  getCodexInferenceThreadQualification,
  ownCodexInferenceClient,
} from "./inference-routing.js";
import { nativeHookRelayUnregisterQueue } from "./native-hook-relay-state.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import type { CodexDynamicToolSpec } from "./protocol.js";
import { prepareCodexAttemptConnection } from "./run-attempt-connection.js";
import { prepareCodexAttemptContext } from "./run-attempt-context.js";
import { prepareCodexAttemptPrompt } from "./run-attempt-prompt.js";
import { prepareCodexAttemptResources } from "./run-attempt-resources.js";
import { prepareCodexAttemptRuntime } from "./run-attempt-runtime.js";
import {
  bindProductionHarnessHostCapabilitiesForTest,
  createParams,
  createStartedThreadHarness,
  extractGenerationFromThreadRequest,
  extractRelayIdFromThreadRequest,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
} from "./run-attempt-test-harness.js";
import { prepareCodexAttemptTools } from "./run-attempt-tool-setup.js";
import {
  registerCodexTestSessionIdentity,
  testCodexAppServerBindingStore,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import * as threadLifecyclePreflight from "./thread-lifecycle-preflight.js";
import { startOrResumeThread } from "./thread-lifecycle.js";

describe("Codex participant native admission", () => {
  setupRunAttemptTestHooks({ sessionOwner: null });
  it.each(["optional", "disabled", "managed-only"] as const)(
    "prepares participant delegation with %s native admission before a turn starts",
    async (hooks) => {
      const params = createParams(
        path.join(tempDir, "participant-model-hooks.jsonl"),
        path.join(tempDir, "participant-model-hooks-workspace"),
      );
      params.sessionKey = undefined;
      registerCodexTestSessionIdentity(params.sessionFile, params.sessionId, params.sessionKey);
      let ambiguous = false;
      const bindModelExecution = () => ({
        signal: new AbortController().signal,
        assertCurrent: () => {},
        release: () => {},
      });
      params.hostCapabilities = createCodexTestHostCapabilities({
        bindModelExecution,
        retainSourceAuthority: () => ({
          ...bindModelExecution(),
          modelPolicyRequired: false,
          bindModelExecution,
        }),
        assertNativeSubagentSpawnAllowed: () => {
          if (ambiguous) {
            throw new Error("Several people have steered this turn");
          }
        },
      });
      const harness = createStartedThreadHarness(async (method) => {
        if (method === "configRequirements/read") {
          return { requirements: { allowManagedHooksOnly: hooks === "managed-only" } };
        }
        if (method === "account/read") {
          return { account: { type: "apiKey" } };
        }
        return undefined;
      });
      ownCodexInferenceClient(harness.client);
      const preflight = vi.spyOn(threadLifecyclePreflight, "prepareCodexThreadLifecyclePreflight");
      const connection = await prepareCodexAttemptConnection({
        params,
        options: {
          bindingStore: testCodexAppServerBindingStore,
          clientFactory: async () => harness.client,
          nativeHookRelay: hooks === "disabled" ? { enabled: false } : undefined,
        },
      });
      try {
        const runtime = await prepareCodexAttemptRuntime(connection);
        const tools = await prepareCodexAttemptTools(runtime);
        try {
          const context = await prepareCodexAttemptContext(runtime, tools);
          const prompt = await prepareCodexAttemptPrompt(context);
          const resources = prepareCodexAttemptResources(prompt);
          resources.state.client = harness.client;
          try {
            const dynamicTools: CodexDynamicToolSpec[] = [
              {
                type: "function",
                name: "sessions_spawn",
                description: "Create an OpenClaw child session.",
                inputSchema: { type: "object", properties: {} },
              },
            ];
            const binding = await startOrResumeThread({
              client: harness.client,
              bindingStore: connection.bindingStore,
              params,
              cwd: connection.effectiveCwd,
              agentDir: connection.agentDir,
              appServer: connection.appServer,
              dynamicTools,
              userMcpServersEnabled: false,
              nativeCodeModeEnabled: runtime.nativeToolSurfaceEnabled,
              nativeModelAdmission: resources.nativeModelAdmission,
              buildFinalConfigPatch: resources.buildNativeHookRelayFinalConfigPatch,
            });
            resources.state.thread = binding;
            expect(preflight).toHaveBeenCalledWith(
              expect.objectContaining({
                nativeModelAdmission: hooks === "disabled" ? "disabled" : "optional",
              }),
            );
            const admission = await preflight.mock.results[0]?.value;
            expect(admission).toBeDefined();
            const start = harness.requests.find(({ method }) => method === "thread/start");
            const route = getCodexInferenceThread(harness.client, binding.threadId);
            expect(route).toBeDefined();
            expect(start?.params).toMatchObject({
              config: { "features.shell_tool": true, openai_base_url: route?.baseUrl },
              dynamicTools,
            });
            expect(harness.requests.some(({ method }) => method === "turn/start")).toBe(false);
            if (hooks === "optional") {
              expect(admission?.nativeModelInputTools).toContain("spawn_agent");
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
                    session_id: binding.threadId,
                    turn_id: "turn-1",
                    tool_name: "Agent",
                    tool_use_id: toolUseId,
                    tool_input: { message: "Inspect the fixture" },
                  },
                });
              await expect(spawn("single-person")).resolves.toMatchObject({
                stdout: "",
                exitCode: 0,
              });
              ambiguous = true;
              const response = await spawn("several-people");
              expect(response.stdout).toContain(
                "Use sessions_spawn with the requester's requester_profile.id as user",
              );
              expect(JSON.parse(response.stdout)).toMatchObject({
                hookSpecificOutput: { permissionDecision: "deny" },
              });
              expect(start?.params).not.toHaveProperty(["config", "agents.enabled"], false);
            } else {
              expect(admission?.nativeModelInputTools).toBeUndefined();
              expect(
                getCodexInferenceThreadQualification(harness.client, binding.threadId),
              ).toBeUndefined();
              expect(start?.params).toMatchObject({
                config: {
                  "agents.enabled": false,
                  "features.multi_agent": false,
                  "features.multi_agent_v2": false,
                },
              });
              expect(start?.params).not.toHaveProperty(["config", "hooks.PreToolUse", 0]);
            }
          } finally {
            await resources.cleanupBeforeActiveTurn();
          }
        } finally {
          await tools.disposeTools("error");
        }
      } finally {
        connection.cancellation.dispose();
        connection.releaseModelExecution();
        harness.close();
      }
    },
  );
});

describe("Codex native hook Gateway fallback", () => {
  setupRunAttemptTestHooks();
  it("cancels an unqualified parent on new policy while preserving its permitted sibling", async () => {
    const params = createParams(
      path.join(tempDir, "retained-model-source.jsonl"),
      path.join(tempDir, "retained-model-source-workspace"),
    );
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
    const selected = { provider: params.provider, model: params.modelId };
    const permitted = params.hostCapabilities.bindModelExecution?.(selected);
    if (!permitted) {
      throw new Error("Expected a canonical operator model guard");
    }
    const harness = createStartedThreadHarness(async (method) =>
      method === "account/read" ? { account: { type: "apiKey" } } : undefined,
    );
    ownCodexInferenceClient(harness.client);
    const abort = new AbortController();
    params.abortSignal = abort.signal;
    const run = runCodexAppServerAttempt(params, { nativeHookRelay: { enabled: false } });
    try {
      await run.waitForTurnAccepted();
      const accepted = await codexNativeSubagentMonitorRuntime.captureModelSource({
        client: harness.client,
        threadId: "thread-1",
        turnId: "turn-1",
      });
      expect(accepted).toBeDefined();
      accepted?.release();
      policy = {
        models: [selected],
        allows: (model) => model.provider === selected.provider && model.model === selected.model,
      };
      for (const changed of listeners) {
        changed();
      }
      expect(readAttemptTerminal(await run).aborted).toBe(true);
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
