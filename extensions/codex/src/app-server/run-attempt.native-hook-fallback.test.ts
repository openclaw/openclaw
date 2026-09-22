import { Server } from "node:http";
import path from "node:path";
import {
  invokeNativeHookRelay,
  nativeHookRelayTesting,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import {
  createEmptyPluginRegistry,
  createMockPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeHookRelayUnregisterQueue } from "./native-hook-relay-state.js";
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
afterEach(() => setActivePluginRegistry(createEmptyPluginRegistry()));

describe("Codex native hook Gateway fallback", () => {
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
