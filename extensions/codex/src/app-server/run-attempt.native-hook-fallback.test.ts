import { Server } from "node:http";
import path from "node:path";
import * as agentHarnessRuntime from "openclaw/plugin-sdk/agent-harness-runtime";
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
  createCodexRuntimePlanFixture,
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
  createCodexTestBindingStore,
  registerCodexTestSessionIdentity,
  testCodexAppServerBindingStore,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import { codexDynamicToolsFingerprint } from "./thread-fingerprints.js";
import * as threadLifecyclePreflight from "./thread-lifecycle-preflight.js";
import { startOrResumeThread } from "./thread-lifecycle-run.js";
import { createLeasedCodexLifecycleHarness } from "./thread-lifecycle.test-fixtures.js";

function participantHostCapabilities(assertNativeSubagentSpawnAllowed: () => void) {
  const bindModelExecution = () => ({
    signal: new AbortController().signal,
    assertCurrent: () => {},
    release: () => {},
  });
  return createCodexTestHostCapabilities({
    bindModelExecution,
    retainSourceAuthority: () => ({
      ...bindModelExecution(),
      modelPolicyRequired: false,
      bindModelExecution,
    }),
    assertNativeSubagentSpawnAllowed,
  });
}

describe("Codex participant native admission", () => {
  setupRunAttemptTestHooks({ sessionOwner: null });
  it.each([
    { hooks: "optional", lifecycle: "fresh", participants: "solo", policy: "normal" },
    { hooks: "disabled", lifecycle: "fresh", participants: "solo", policy: "normal" },
    { hooks: "managed-only", lifecycle: "resumed", participants: "solo", policy: "normal" },
    { hooks: "disabled", lifecycle: "fresh", participants: "multiple", policy: "normal" },
    { hooks: "disabled", lifecycle: "fresh", participants: "multiple", policy: "token-sharing" },
  ] as const)(
    "handles $participants participants with $hooks native admission on a $lifecycle $policy thread",
    async ({ hooks, lifecycle, participants, policy }) => {
      const params = createParams(
        path.join(tempDir, "participant-model-hooks.jsonl"),
        path.join(tempDir, "participant-model-hooks-workspace"),
      );
      params.sessionKey = undefined;
      if (policy === "token-sharing") {
        const runtimePlan = createCodexRuntimePlanFixture();
        params.runtimePlan = {
          ...runtimePlan,
          auth: {
            ...runtimePlan.auth,
            selectedAuthMode: "oauth",
            selectedAuthFlow: "chatgpt-token-sharing",
          },
        };
      }
      registerCodexTestSessionIdentity(params.sessionFile, params.sessionId, params.sessionKey);
      const dynamicTools: CodexDynamicToolSpec[] = [
        {
          type: "function",
          name: "sessions_spawn",
          description: "Create an OpenClaw child session.",
          inputSchema: { type: "object", properties: {} },
        },
      ];
      if (lifecycle === "resumed") {
        await writeCodexAppServerBinding(params.sessionFile, {
          threadId: "thread-existing",
          cwd: params.workspaceDir,
          model: params.modelId,
          modelProvider: "openai",
          dynamicToolsFingerprint: codexDynamicToolsFingerprint(dynamicTools),
          dynamicToolsContainDeferred: false,
          webSearchThreadConfigFingerprint: JSON.stringify({
            "features.standalone_web_search": false,
            web_search: "disabled",
          }),
        });
      }
      const ambiguity = new Error(
        "Several people have steered this turn: Alice (user: alice), Bob (user: bob). Pass the requester's requester_profile.id as user, or ask them if unclear.",
      );
      let spawnFailure: Error | undefined;
      params.hostCapabilities = participantHostCapabilities(() => {
        if (spawnFailure) {
          throw spawnFailure;
        }
      });
      const harness = await createLeasedCodexLifecycleHarness({
        agentDir: path.join(tempDir, "participant-wire-agent"),
        persistedThreads: lifecycle === "resumed" ? ["thread-existing"] : [],
        respond: async (method) => {
          if (method === "configRequirements/read") {
            return { requirements: { allowManagedHooksOnly: hooks === "managed-only" } };
          }
          if (method === "config/read") {
            return { config: {}, origins: {}, layers: [] };
          }
          if (method === "account/read") {
            return { account: { type: "apiKey" } };
          }
          if (method === "thread/start" || method === "thread/resume") {
            return threadStartResult(lifecycle === "resumed" ? "thread-existing" : "thread-1");
          }
          return {};
        },
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
            const startThread = () =>
              startOrResumeThread({
                client: harness.client,
                bindingStore: connection.bindingStore,
                params,
                signal: connection.runAbortController.signal,
                cwd: connection.effectiveCwd,
                agentDir: connection.agentDir,
                appServer: connection.appServer,
                dynamicTools,
                userMcpServersEnabled: false,
                nativeCodeModeEnabled: runtime.nativeToolSurfaceEnabled,
                nativeModelAdmission: resources.nativeModelAdmission,
                buildFinalConfigPatch: resources.buildNativeHookRelayFinalConfigPatch,
              });
            if (participants === "multiple") {
              spawnFailure = ambiguity;
            }
            if (participants === "multiple" && policy === "normal") {
              for (const message of [
                "Alice's access changed; ask them again",
                "This turn has ended; ask again in a new turn.",
              ]) {
                spawnFailure = new Error(message);
                await expect(
                  resources.buildNativeHookRelayFinalConfigPatch({ action: "start" }),
                ).rejects.toBe(spawnFailure);
              }
              spawnFailure = ambiguity;
              await expect(startThread()).rejects.toMatchObject({
                message:
                  "Several people have steered this turn, and this Codex setup cannot run native sub-agents safely for more than one person without native hook admission. Send the request again as a new message so it runs as its own turn.",
                cause: ambiguity,
              });
              expect(
                harness.request.mock.calls.filter(([method]) =>
                  ["thread/start", "thread/resume", "turn/start"].includes(method),
                ),
              ).toEqual([]);
              return;
            }
            const binding = await startThread();
            resources.state.thread = binding;
            expect(preflight).toHaveBeenCalledWith(
              expect.objectContaining({
                nativeModelAdmission:
                  policy === "token-sharing"
                    ? undefined
                    : hooks === "disabled"
                      ? "disabled"
                      : "optional",
              }),
            );
            const admission = await preflight.mock.results[0]?.value;
            expect(admission).toBeDefined();
            const request = harness.request.mock.calls.find(
              ([method]) => method === (lifecycle === "resumed" ? "thread/resume" : "thread/start"),
            )?.[1];
            expect(request).toBeDefined();
            expect(binding.lifecycle.action).toBe(lifecycle === "resumed" ? "resumed" : "started");
            const route = getCodexInferenceThread(harness.client, binding.threadId);
            expect(route).toBeDefined();
            expect(request).toMatchObject({
              config: {
                ...(policy === "normal" ? { "features.shell_tool": true } : {}),
                openai_base_url: route?.baseUrl,
              },
              ...(lifecycle === "fresh" ? { dynamicTools } : {}),
            });
            expect(harness.request.mock.calls.some(([method]) => method === "turn/start")).toBe(
              false,
            );
            if (policy === "token-sharing") {
              expect(request).toMatchObject({
                config: {
                  "agents.enabled": false,
                  "features.multi_agent": false,
                  "features.multi_agent_v2": false,
                },
              });
            } else {
              expect(request).not.toHaveProperty(["config", "agents.enabled"], false);
              expect(request).not.toHaveProperty(["config", "features.multi_agent"], false);
              expect(request).not.toHaveProperty(["config", "features.multi_agent_v2"], false);
            }
            if (hooks === "optional") {
              expect(admission?.nativeModelInputTools).toContain("spawn_agent");
              const relayId = extractRelayIdFromThreadRequest(request);
              const generation = extractGenerationFromThreadRequest(request);
              const spawn = (toolUseId: string) =>
                agentHarnessRuntime.invokeNativeHookRelay({
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
              spawnFailure = ambiguity;
              const response = await spawn("several-people");
              expect(response.stdout).toContain(
                "Use sessions_spawn with the requester's requester_profile.id as user",
              );
              expect(JSON.parse(response.stdout)).toMatchObject({
                hookSpecificOutput: { permissionDecision: "deny" },
              });
            } else {
              expect(admission?.nativeModelInputTools).toBeUndefined();
              const qualification = getCodexInferenceThreadQualification(
                harness.client,
                binding.threadId,
              );
              if (policy === "token-sharing") {
                expect(qualification).toBeDefined();
              } else {
                expect(qualification).toBeUndefined();
              }
              expect(request).not.toHaveProperty(["config", "hooks.PreToolUse", 0]);
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
      }
    },
  );
});

describe("Codex native hook Gateway fallback", () => {
  setupRunAttemptTestHooks();
  it("publishes cross-profile steering from effective delegation policy and installed admission", async () => {
    const registered = vi.spyOn(agentHarnessRuntime, "setActiveEmbeddedRun");
    for (const { hooks, policy, supportsSteering } of [
      { hooks: "disabled", policy: "normal", supportsSteering: false },
      { hooks: "optional", policy: "normal", supportsSteering: true },
      { hooks: "disabled", policy: "token-sharing", supportsSteering: true },
      { hooks: "disabled", policy: "report-only", supportsSteering: true },
      { hooks: "disabled", policy: "tool-search-unsupported", supportsSteering: false },
    ] as const) {
      registered.mockClear();
      const params = createParams(
        path.join(tempDir, `participant-handle-${hooks}-${policy}.jsonl`),
        path.join(tempDir, `participant-handle-${hooks}-${policy}-workspace`),
      );
      params.hostCapabilities = participantHostCapabilities(() => {});
      if (policy === "token-sharing") {
        const runtimePlan = createCodexRuntimePlanFixture();
        params.runtimePlan = {
          ...runtimePlan,
          auth: {
            ...runtimePlan.auth,
            selectedAuthMode: "oauth",
            selectedAuthFlow: "chatgpt-token-sharing",
          },
        };
      } else if (policy === "report-only") {
        params.delegationCapability = "report_only";
      } else if (policy === "tool-search-unsupported") {
        params.modelId = "gpt-5.4-nano";
      }
      const harness = createStartedThreadHarness(async (method) => {
        if (method === "configRequirements/read") {
          return { requirements: { allowManagedHooksOnly: false } };
        }
        if (method === "account/read") {
          return { account: { type: "apiKey" } };
        }
        return undefined;
      });
      ownCodexInferenceClient(harness.client);
      const abort = new AbortController();
      params.abortSignal = abort.signal;
      const run = runCodexAppServerAttempt(params, {
        bindingStore: createCodexTestBindingStore(),
        nativeHookRelay: hooks === "disabled" ? { enabled: false } : undefined,
      });
      try {
        await run.waitForTurnAccepted();
        expect(registered).toHaveBeenCalledTimes(1);
        const backend = registered.mock.calls[0]?.[1];
        expect
          .soft(backend?.supportsCrossProfileSteering, `${hooks}: ${policy}`)
          .toBe(supportsSteering);
        const request = harness.requests.find(({ method }) => method === "thread/start")?.params;
        if (policy === "token-sharing" || policy === "report-only") {
          expect(request).toMatchObject({
            config: {
              "agents.enabled": false,
              "features.multi_agent": false,
              "features.multi_agent_v2": false,
            },
          });
        } else if (policy === "tool-search-unsupported") {
          expect(request).toMatchObject({ config: { "features.multi_agent": false } });
          expect(request).not.toHaveProperty(["config", "features.multi_agent_v2"], false);
          expect(request).not.toHaveProperty(["config", "agents.enabled"], false);
        }
        await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
        await run;
      } finally {
        abort.abort("test cleanup");
        await run.catch(() => undefined);
        harness.close();
      }
    }
  });
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
      const response = await agentHarnessRuntime.invokeNativeHookRelay({
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
        agentHarnessRuntime.nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId),
      ).toBeUndefined();
    } finally {
      abort.abort("test cleanup");
      await Promise.allSettled([run]);
      closeHost();
    }
  });
});
