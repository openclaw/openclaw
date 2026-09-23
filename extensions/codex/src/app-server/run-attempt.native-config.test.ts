import fs from "node:fs/promises";
import path from "node:path";
import {
  embeddedAgentLog,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "./client.js";
import { resolveCodexSupervisionAppServerRuntimeOptions } from "./config.js";
import { setCodexTestToolFactory } from "./host-capability.test-support.js";
import { buildCodexAppServerConnectionFingerprint } from "./plugin-app-cache-key.js";
import { isJsonObject } from "./protocol.js";
import {
  createParams,
  createRuntimeDynamicTool,
  getMockRuntimeIdentity,
  mockCall,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  turnStartResult,
  userMessage,
} from "./run-attempt-test-harness.js";
import { writeCodexAppServerBinding } from "./session-binding.test-helpers.js";
import * as settledTurnContext from "./settled-turn-context.js";
import * as sharedClientModule from "./shared-client.js";
import {
  appendSqliteHistoryMessage,
  attachSqliteSessionTarget,
  readTranscriptMessagesByIdentity,
} from "./sqlite-session.test-helpers.js";
import { createClientHarness, createCodexTestModel } from "./test-support.js";
import { codexDynamicToolsFingerprint } from "./thread-fingerprints.js";

const agentHarnessRuntimeMocks = vi.hoisted(() => ({ forceModelToolsUnsupported: false }));

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>();
  return {
    ...actual,
    supportsModelTools: (...args: Parameters<typeof actual.supportsModelTools>) =>
      agentHarnessRuntimeMocks.forceModelToolsUnsupported
        ? false
        : actual.supportsModelTools(...args),
    materializeRequesterScopedMcpToolsForHarnessRun: async () => undefined,
  };
});

setupRunAttemptTestHooks();

describe("Codex native configuration", () => {
  it.each<{
    transport: "stdio" | "proxy" | "websocket" | "unix";
    hasAnswer: boolean;
    nativeProvider: string;
    configuredProvider?: string;
  }>([
    { transport: "stdio", hasAnswer: true, nativeProvider: "openai" },
    { transport: "stdio", hasAnswer: false, nativeProvider: "openai" },
    { transport: "proxy", hasAnswer: true, nativeProvider: "openai" },
    { transport: "proxy", hasAnswer: false, nativeProvider: "openai" },
    { transport: "websocket", hasAnswer: false, nativeProvider: "openai" },
    { transport: "unix", hasAnswer: true, nativeProvider: "openai" },
    { transport: "unix", hasAnswer: false, nativeProvider: "openai" },
    { transport: "unix", hasAnswer: true, nativeProvider: "copilot" },
    { transport: "unix", hasAnswer: true, nativeProvider: "openai", configuredProvider: "copilot" },
    { transport: "unix", hasAnswer: true, nativeProvider: "copilot", configuredProvider: "openai" },
    // Earlier releases recorded disabled search for custom native providers.
    { transport: "stdio", hasAnswer: true, nativeProvider: "copilot" },
  ])(
    "preserves supervised native model and transport/home guards over $transport (answer: $hasAnswer, provider: $nativeProvider, configured: $configuredProvider)",
    async ({ transport, hasAnswer, nativeProvider, configuredProvider = nativeProvider }) => {
      const nativeSearchEnabled =
        nativeProvider === "copilot" || configuredProvider !== nativeProvider;
      const approvalsReviewer =
        nativeProvider === "openai" && configuredProvider === nativeProvider
          ? "auto_review"
          : "user";
      const sessionFile = path.join(tempDir, "session.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      const agentDir = path.join(tempDir, "agent");
      const beforePromptBuild = vi.fn(() => undefined);
      initializeGlobalHookRunner(
        createMockPluginRegistry([{ hookName: "before_prompt_build", handler: beforePromptBuild }]),
      );
      const codexHome = path.join(tempDir, "review-codex-home");
      vi.stubEnv("CODEX_HOME", codexHome);
      const rolloutPath = path.join(codexHome, "sessions", "thread-existing.jsonl");
      await fs.mkdir(path.dirname(rolloutPath), { recursive: true });
      await fs.writeFile(
        rolloutPath,
        JSON.stringify({
          type: "session_meta",
          payload: { id: "thread-existing", model_provider: nativeProvider },
        }) + "\n",
      );
      const pluginConfig = {
        appServer: {
          mode: "guardian",
          command: process.execPath,
          args: transport === "proxy" ? ["app-server", "proxy"] : ["app-server"],
          transport: transport === "proxy" ? "stdio" : transport,
          ...(transport === "websocket" ? { url: "ws://127.0.0.1:8123" } : {}),
          ...(transport === "unix" ? { url: "unix:///tmp/synthetic-codex.sock" } : {}),
        },
        supervision: { enabled: true },
      };
      await writeCodexAppServerBinding(sessionFile, {
        threadId: "thread-existing",
        cwd: workspaceDir,
        historyCoveredThrough: new Date().toISOString(),
        webSearchThreadConfigFingerprint: JSON.stringify({
          "features.standalone_web_search": false,
          web_search: "disabled",
        }),
        connectionScope: "supervision",
        supervisionSourceThreadId: "thread-existing",
        model: "gpt-5.5",
        modelProvider: nativeProvider,
        preserveNativeModel: true,
        conversationSourceTransferComplete: true,
        dynamicToolsFingerprint: codexDynamicToolsFingerprint([]),
        ...(nativeSearchEnabled && transport === "unix"
          ? {
              webSearchThreadConfigFingerprint: JSON.stringify({
                "features.standalone_web_search": false,
                web_search: "cached",
              }),
            }
          : {}),
        rolloutPath,
        appServerRuntimeFingerprint: buildCodexAppServerConnectionFingerprint(
          resolveCodexSupervisionAppServerRuntimeOptions({ pluginConfig }),
          agentDir,
        ),
      });
      const nativeResponse = {
        ...threadStartResult("thread-existing", { cwd: workspaceDir }),
        model: "gpt-5.6-luna",
        modelProvider: nativeProvider,
        approvalsReviewer,
        serviceTier: "priority",
      };
      const turnStarted = createDeferred<void>();
      const requests: Array<{ method: string; params: unknown }> = [];
      const harness = createClientHarness({
        onWrite: (line, send) => {
          const message: unknown = JSON.parse(line);
          if (
            !isJsonObject(message) ||
            typeof message.method !== "string" ||
            message.id === undefined
          ) {
            return;
          }
          requests.push({ method: message.method, params: message.params });
          let result: unknown = {};
          if (message.method === "initialize") {
            result = {
              userAgent: `codex-cli/${getMockRuntimeIdentity().serverVersion}`,
              codexHome,
            };
          } else if (message.method === "configRequirements/read") {
            result = { requirements: null };
          } else if (message.method === "config/read") {
            result = { config: { model_provider: configuredProvider }, origins: {} };
          } else if (message.method === "modelProvider/capabilities/read") {
            result = { webSearch: true };
          } else if (message.method === "thread/read") {
            result = { thread: { ...nativeResponse.thread, path: rolloutPath } };
          } else if (message.method === "thread/resume") {
            // Native resume tears down an idle, unsubscribed thread before applying overrides.
            // A successful response alone cannot prove that its configuration changed.
            send({
              method: "thread/status/changed",
              params: { threadId: "thread-existing", status: { type: "notLoaded" } },
            });
            result = nativeResponse;
          } else if (message.method === "turn/start") {
            result = turnStartResult();
            turnStarted.resolve();
          } else if (message.method === "thread/unsubscribe") {
            result = { status: "unsubscribed" };
          }
          send({ id: message.id, result });
        },
      });
      const start = vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
      const clientFactory = vi.fn(sharedClientModule.getLeasedSharedCodexAppServerClient);

      // This test owns review-policy projection, not requester-scoped MCP discovery.
      agentHarnessRuntimeMocks.forceModelToolsUnsupported = !nativeSearchEnabled;
      const params = createParams(sessionFile, workspaceDir);
      setCodexTestToolFactory(params, () =>
        nativeSearchEnabled ? [createRuntimeDynamicTool("web_search")] : [],
      );
      params.registerPluginRuntimeRefreshConsumer = vi.fn();
      params.agentDir = agentDir;
      params.provider = "anthropic";
      params.modelId = "claude-opus-4-6";
      params.model = createCodexTestModel("anthropic");
      params.fastMode = true;
      await attachSqliteSessionTarget(
        params,
        path.join(tempDir, "supervised-settlement.sqlite"),
        params.sessionId,
      );
      await appendSqliteHistoryMessage(params, userMessage("Preserve the prior conversation.", 1));
      const priorTranscript = await readTranscriptMessagesByIdentity(params);
      const capture = vi.spyOn(settledTurnContext, "captureCodexSettledTurnFinalizationContext");
      const warn = vi.spyOn(embeddedAgentLog, "warn");
      setCodexTestModelSupportsTools(params, nativeSearchEnabled);
      params.config = {
        ...params.config,
        tools: {
          ...params.config?.tools,
          exec: { mode: configuredProvider === nativeProvider ? "auto" : "ask" },
        },
      } as EmbeddedRunAttemptParams["config"];
      if (nativeSearchEnabled) {
        params.config = {
          ...params.config,
          tools: { ...params.config?.tools, web: { search: { enabled: true } } },
        };
      }
      const run = runCodexAppServerAttempt(params, {
        pluginConfig,
        clientFactory,
      });
      try {
        if (transport === "websocket") {
          await expect(run).rejects.toThrow(
            "original verified local binding and selected native connection",
          );
          expect(
            requests.some(({ method }) => method === "thread/resume" || method === "turn/start"),
          ).toBe(false);
          return;
        }
        await Promise.race([
          turnStarted.promise,
          run.then((result) => {
            throw new Error("Codex attempt ended before turn/start", { cause: result });
          }),
        ]);
        for (const method of ["item/started", "item/completed"]) {
          harness.send({
            method,
            params: {
              threadId: "thread-existing",
              turnId: "turn-1",
              item: {
                type: "commandExecution",
                id: "settled-supervised-command",
                command: "printf synthetic-completed-work",
                cwd: workspaceDir,
                status: method === "item/started" ? "inProgress" : "completed",
                ...(method === "item/completed"
                  ? { aggregatedOutput: "synthetic-completed-work", exitCode: 0 }
                  : {}),
              },
            },
          });
        }
        harness.send({
          method: "turn/completed",
          params: {
            threadId: "thread-existing",
            turn: {
              id: "turn-1",
              status: "completed",
              items: hasAnswer
                ? [{ type: "agentMessage", id: "native-answer", text: "native answer" }]
                : [],
            },
          },
        });
        const result = await run;
        expect(result.terminal).toEqual({ kind: "ok" });
        expect(params.registerPluginRuntimeRefreshConsumer).not.toHaveBeenCalled();
        expect(beforePromptBuild).toHaveBeenCalled();
        for (let index = 0; index < beforePromptBuild.mock.calls.length; index += 1) {
          const context = mockCall(beforePromptBuild, "before_prompt_build", index)[1];
          expect(context).not.toHaveProperty("modelProviderId");
          expect(context).not.toHaveProperty("modelId");
        }
        expect(result.runtimeModelSelection).toEqual({
          provider: nativeProvider,
          model: "gpt-5.6-luna",
        });
        expect(capture).not.toHaveBeenCalled();
        if (hasAnswer) {
          expect(result.currentAttemptAssistant).toMatchObject({
            provider: nativeProvider,
            model: "gpt-5.6-luna",
          });
          expect(result.settledTurnFinalizationContext).toBeUndefined();
        } else {
          expect(result.settledTurnFinalizationContext).toEqual({ source: "unavailable" });
          expect(Object.isFrozen(result.settledTurnFinalizationContext)).toBe(true);
          expect(warn).toHaveBeenCalledWith(
            "codex settled-turn finalization context is unavailable",
            expect.objectContaining({
              runId: params.runId,
              threadId: "thread-existing",
              turnId: "turn-1",
              reason: "native_auth_finalization_unsupported",
            }),
          );
        }
        expect(result.messagesSnapshot).toContainEqual(
          expect.objectContaining({
            role: "toolResult",
            toolCallId: "settled-supervised-command",
            isError: false,
            content: expect.arrayContaining([
              expect.objectContaining({
                type: "text",
                text: "synthetic-completed-work",
              }),
            ]),
          }),
        );
        expect(result.replayMetadata).toMatchObject({
          hadPotentialSideEffects: true,
          replaySafe: false,
        });
        const transcript = await readTranscriptMessagesByIdentity(params);
        expect(transcript.slice(0, priorTranscript.length)).toEqual(priorTranscript);
        expect(transcript).toContainEqual(expect.objectContaining({ role: "toolResult" }));
        expect(requests.filter(({ method }) => method === "turn/start")).toHaveLength(1);
      } finally {
        start.mockRestore();
        await harness.client.closeAndWait();
      }
      expect(clientFactory).toHaveBeenCalledWith(
        expect.objectContaining({
          authProfileId: null,
          startOptions: expect.objectContaining({ homeScope: "user" }),
        }),
      );
      const resumeRequest = requests.find((request) => request.method === "thread/resume");
      const resumeParams = resumeRequest?.params as Record<string, unknown> | undefined;
      expect(resumeParams).not.toHaveProperty("model");
      expect(resumeParams).not.toHaveProperty("modelProvider");
      if (nativeSearchEnabled) {
        expect(resumeParams?.config).toMatchObject({
          web_search: transport === "unix" ? "cached" : "disabled",
        });
        expect(requests.some(({ method }) => method === "thread/start")).toBe(false);
      }
      expect(resumeParams?.approvalsReviewer).toBe(approvalsReviewer);
      expect(resumeParams?.serviceTier).toBe("priority");
      const turnRequest = requests.find((request) => request.method === "turn/start");
      const turnParams = turnRequest?.params as Record<string, unknown> | undefined;
      expect(turnParams).not.toHaveProperty("model");
      expect(turnParams).not.toHaveProperty("modelProvider");
      expect(turnParams?.approvalsReviewer).toBe(approvalsReviewer);
      expect(turnParams?.serviceTier).toBe("priority");
    },
  );
});
