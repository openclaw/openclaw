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
  createStartedThreadHarness,
  extractGenerationFromThreadRequest,
  extractRelayIdFromThreadRequest,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
} from "./run-attempt-test-harness.js";
import { writeCodexAppServerBinding } from "./session-binding.test-helpers.js";

setupRunAttemptTestHooks();

describe("Codex native hook Gateway fallback", () => {
  it.each(["disabled", "managed-only"] as const)(
    "preserves a no-policy operator's %s profile until a policy is introduced",
    async (hooks) => {
      const params = createParams(
        path.join(tempDir, "optional-model-hooks.jsonl"),
        path.join(tempDir, "optional-model-hooks-workspace"),
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
      const started = createDeferred<void>();
      const harness = createStartedThreadHarness(async (method) => {
        if (method === "configRequirements/read") {
          return { requirements: { allowManagedHooksOnly: hooks === "managed-only" } };
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
        nativeHookRelay: hooks === "disabled" ? { enabled: false } : undefined,
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
          config: { "features.shell_tool": true, openai_base_url: route?.baseUrl },
        });
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
    },
  );

  it.each(["fresh", "resumed"] as const)(
    "keeps %s native hook policy available when the direct listener fails",
    async (selection) => {
      const sessionFile = path.join(tempDir, "listener-unavailable.jsonl");
      const workspaceDir = path.join(tempDir, "listener-unavailable-workspace");
      if (selection === "resumed") {
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
      }
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
        { persistedThreads: selection === "resumed" ? ["thread-existing"] : [] },
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
        const request = harness.requests.find(
          ({ method }) => method === (selection === "resumed" ? "thread/resume" : "thread/start"),
        );
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
          threadId: selection === "resumed" ? "thread-existing" : "thread-1",
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
    },
  );
});
