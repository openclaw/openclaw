import fs from "node:fs/promises";
import path from "node:path";
import {
  embeddedAgentLog,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import {
  createAgentHarnessHostCapabilitiesForTest,
  createMockPluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { createCodexAppServerAgentHarness } from "../../harness.js";
import { resolveCodexAppServerHomeDir } from "./auth-start-options.js";
import { CodexAppServerClient } from "./client.js";
import { resolveCodexSupervisionAppServerRuntimeOptions } from "./config.js";
import { setCodexTestToolFactory } from "./host-capability.test-support.js";
import { ownCodexInferenceClient } from "./inference-routing.js";
import { buildCodexRuntimeModelParams } from "./model-runtime.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import {
  createClient,
  directSpawnItem,
  createRuntime,
  createTaskScope,
  threadRead,
  notifyChildStarted,
  turnStartedNotification,
  childTurnCompletedNotification,
} from "./native-subagent-monitor.test-support.js";
import { buildCodexAppServerConnectionFingerprint } from "./plugin-app-cache-key.js";
import { isJsonObject } from "./protocol.js";
import {
  bindProductionHarnessHostCapabilitiesForTest,
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
import {
  testCodexAppServerBindingStore,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import * as settledTurnContext from "./settled-turn-context.js";
import * as sharedClientModule from "./shared-client.js";
import {
  appendSqliteHistoryMessage,
  attachSqliteSessionTarget,
  readTranscriptMessagesByIdentity,
} from "./sqlite-session.test-helpers.js";
import {
  createClientHarness,
  createCodexTestModel,
  createCodexTestOAuthProfile,
} from "./test-support.js";
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
  it.each([
    { permission: "denied", retryModel: "native-retry" },
    { permission: "allowed", retryModel: "openai/native-retry" },
    { permission: "revoked", retryModel: "native-retry" },
  ])(
    "binds the actual harness retry model when its permission is $permission",
    async ({ permission, retryModel }) => {
      const catalogModel = "catalog-primary";
      const runtimeModel = "native-primary";
      const allowedModels = new Set([
        catalogModel,
        ...(permission === "denied" ? [] : ["native-retry"]),
      ]);
      const policyListeners = new Set<() => void>();
      const params = createParams(path.join(tempDir, "session.jsonl"), tempDir, {
        provider: "openai",
      });
      params.agentDir = path.join(tempDir, "agent");
      params.authProfileId = "openai:retry-policy";
      params.authProfileStore.profiles[params.authProfileId] = {
        ...createCodexTestOAuthProfile("synthetic-account"),
        expires: Date.now() + 60 * 60 * 1_000,
      };
      params.modelId = catalogModel;
      params.model = {
        ...params.model,
        id: catalogModel,
        params: buildCodexRuntimeModelParams(catalogModel, runtimeModel),
      };
      setCodexTestToolFactory(params, () => []);
      agentHarnessRuntimeMocks.forceModelToolsUnsupported = true;
      await attachSqliteSessionTarget(
        params,
        path.join(tempDir, "retry-model-policy.sqlite"),
        params.sessionId,
      );
      const closeHost = await bindProductionHarnessHostCapabilitiesForTest(params, {
        profileId: "restricted-retry-fixture",
        scopes: ["operator.write"],
        assertCurrent: () => {},
        get modelPolicy() {
          const models = [...allowedModels].map((model) => ({ provider: "openai", model }));
          return {
            models,
            allows: (ref: (typeof models)[number]) =>
              models.some(
                ({ provider, model }) => ref.provider === provider && ref.model === model,
              ),
          };
        },
        onModelPolicyChanged: (listener) => {
          policyListeners.add(listener);
          return () => {
            policyListeners.delete(listener);
          };
        },
      });
      const allowedControl = params.hostCapabilities.bindModelExecution?.({
        provider: "openai",
        model: catalogModel,
      });
      const sourceControl = params.hostCapabilities.retainSourceAuthority?.();
      const abortController = new AbortController();
      params.abortSignal = abortController.signal;
      const primaryStarted = createDeferred<void>();
      const retryStarted = createDeferred<void>();
      const turnModels: unknown[] = [];
      let nativeResponse = threadStartResult("thread-policy", { cwd: tempDir });
      const transport = createClientHarness({
        onWrite: (line, send) => {
          const message: unknown = JSON.parse(line);
          if (!isJsonObject(message) || message.id === undefined) {
            return;
          }
          const request = isJsonObject(message.params) ? message.params : {};
          let result: unknown = {};
          if (message.method === "initialize") {
            result = {
              userAgent: `codex-cli/${getMockRuntimeIdentity().serverVersion}`,
              codexHome: resolveCodexAppServerHomeDir(params.agentDir),
            };
          } else if (message.method === "configRequirements/read") {
            result = { requirements: null };
          } else if (message.method === "config/read") {
            result = { config: {}, origins: {}, layers: [] };
          } else if (message.method === "account/login/start") {
            result = { type: "chatgptAuthTokens" };
          } else if (message.method === "account/read") {
            result = {
              account: { type: "chatgpt", email: "synthetic@example.test", planType: "team" },
              requiresOpenaiAuth: true,
            };
          } else if (message.method === "thread/read") {
            result = { thread: nativeResponse.thread };
          } else if (message.method === "thread/start" || message.method === "thread/resume") {
            if (typeof request.model !== "string") {
              throw new Error("Expected the selected native model in the thread request");
            }
            nativeResponse = { ...nativeResponse, model: request.model };
            send({
              method: "thread/status/changed",
              params: { threadId: "thread-policy", status: { type: "notLoaded" } },
            });
            result = nativeResponse;
          } else if (message.method === "turn/start") {
            turnModels.push(request.model);
            result = turnStartResult(`turn-${turnModels.length}`);
          } else if (message.method === "thread/backgroundTerminals/list") {
            result = { data: [], nextCursor: null };
          } else if (message.method === "thread/unsubscribe") {
            result = { status: "unsubscribed" };
          }
          send({ id: message.id, result });
          if (message.method === "turn/start") {
            (turnModels.length === 1 ? primaryStarted : retryStarted).resolve();
          } else if (message.method === "turn/interrupt") {
            send({
              method: "turn/completed",
              params: {
                threadId: "thread-policy",
                turn: { id: request.turnId, status: "interrupted", items: [] },
              },
            });
          }
        },
      });
      // The controlled stdio fixture represents the managed process returned by startup.
      ownCodexInferenceClient(transport.client);
      vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(transport.client);
      const harness = createCodexAppServerAgentHarness({
        bindingStore: testCodexAppServerBindingStore,
        pluginConfig: {
          appServer: {
            command: process.execPath,
            args: ["app-server"],
            homeScope: "agent",
            cyberFailover: { mode: "auto", model: retryModel },
          },
        },
      });
      if (!harness.runAttempt) {
        throw new Error("Registered Codex harness must support run attempts");
      }
      const run = harness.runAttempt(params);
      const settled = run.then(
        () => false,
        () => false,
      );
      try {
        await Promise.race([primaryStarted.promise, run]);
        expect(turnModels).toEqual([runtimeModel]);
        const error = { message: "Synthetic provider refusal", codexErrorInfo: "cyberPolicy" };
        transport.send({
          method: "error",
          params: { threadId: "thread-policy", turnId: "turn-1", error, willRetry: false },
        });
        transport.send({
          method: "turn/completed",
          params: {
            threadId: "thread-policy",
            turn: { id: "turn-1", status: "failed", items: [], error },
          },
        });
        const retried = await Promise.race([retryStarted.promise.then(() => true), settled]);
        if (permission === "revoked") {
          allowedModels.delete("native-retry");
          for (const listener of policyListeners) {
            listener();
          }
        }
        expect(allowedControl?.signal.aborted).toBe(false);
        expect(sourceControl?.signal?.aborted).toBe(false);
        allowedControl?.assertCurrent();
        sourceControl?.assertCurrent();
        if (retried) {
          transport.send({
            method: "turn/completed",
            params: {
              threadId: "thread-policy",
              turn: {
                id: "turn-2",
                status: "completed",
                items: [
                  { type: "agentMessage", id: "retry-answer", text: "Synthetic retry reply" },
                ],
              },
            },
          });
        }
        if (permission === "denied") {
          expect(turnModels).toEqual([runtimeModel]);
          await expect(run).rejects.toThrow("operator role cannot use this model");
        } else {
          expect(turnModels).toEqual([runtimeModel, "native-retry"]);
          if (permission === "revoked") {
            await expect(run).rejects.toThrow("operator role cannot use this model");
          } else {
            await expect(run).resolves.toMatchObject({ terminal: { kind: "ok" } });
          }
        }
        expect(params.modelId).toBe(catalogModel);
        expect(params.model.id).toBe(catalogModel);
        const transcript = await readTranscriptMessagesByIdentity(params);
        expect(transcript.filter((message) => message.role === "user")).toHaveLength(1);
      } finally {
        abortController.abort("test_cleanup");
        await run.catch(() => undefined);
        allowedControl?.release();
        sourceControl?.release();
        closeHost();
        await harness.dispose?.();
        await transport.client.closeAndWait();
      }
      expect(policyListeners.size).toBe(0);
    },
  );

  it.each<{
    transport: "stdio" | "proxy" | "websocket" | "unix";
    hasAnswer: boolean;
    nativeProvider: string;
    configuredProvider?: string;
    modelPolicyAction?: "deny" | "revoke";
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
    { transport: "stdio", hasAnswer: true, nativeProvider: "openai", modelPolicyAction: "deny" },
    { transport: "stdio", hasAnswer: true, nativeProvider: "openai", modelPolicyAction: "revoke" },
  ])(
    "preserves supervised native model and transport/home guards over $transport (answer: $hasAnswer, provider: $nativeProvider, configured: $configuredProvider, model policy: $modelPolicyAction)",
    async ({
      transport,
      hasAnswer,
      nativeProvider,
      configuredProvider = nativeProvider,
      modelPolicyAction,
    }) => {
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
      const modelRevocation = new AbortController();
      const releaseModelExecution = vi.fn();
      const bindModelExecution = vi.fn<
        NonNullable<typeof params.hostCapabilities.bindModelExecution>
      >((model) => {
        expect(model).toEqual({ provider: nativeProvider, model: "gpt-5.6-luna" });
        if (modelPolicyAction === "deny") {
          throw new Error("operator role cannot use this model");
        }
        return {
          signal: modelRevocation.signal,
          assertCurrent: () => modelRevocation.signal.throwIfAborted(),
          release: releaseModelExecution,
        };
      });
      params.hostCapabilities = { ...params.hostCapabilities, bindModelExecution };
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
        if (modelPolicyAction === "deny") {
          await expect(run).rejects.toThrow("operator role cannot use this model");
          expect(bindModelExecution).toHaveBeenCalledOnce();
          expect(requests.some(({ method }) => method === "turn/start")).toBe(false);
          return;
        }
        await Promise.race([
          turnStarted.promise,
          run.then((result) => {
            throw new Error("Codex attempt ended before turn/start", { cause: result });
          }),
        ]);
        if (modelPolicyAction === "revoke") {
          modelRevocation.abort(new Error("operator model permission was revoked"));
          harness.send({
            method: "turn/completed",
            params: {
              threadId: "thread-existing",
              turn: { id: "turn-1", status: "interrupted", items: [] },
            },
          });
          await expect(run).rejects.toThrow("operator model permission was revoked");
          expect(releaseModelExecution).toHaveBeenCalledOnce();
          return;
        }
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
        expect(bindModelExecution).toHaveBeenCalledOnce();
        expect(releaseModelExecution).toHaveBeenCalledOnce();
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

it.each(["restore", "fresh", "fresh after yield"] as const)(
  "cancels accepted unqualified native work when a policy is introduced (%s)",
  async (origin) => {
    const fresh = origin !== "restore";
    const yielded = origin !== "fresh";
    const client = createClient();
    const runtime = createRuntime();
    type Source = NonNullable<
      Parameters<typeof createAgentHarnessHostCapabilitiesForTest>[0]["operatorSource"]
    >;
    let policy: Source["modelPolicy"];
    const listeners = new Set<() => void>();
    const attempt = createParams(
      path.join(tempDir, "unqualified-source.jsonl"),
      path.join(tempDir, "unqualified-source-workspace"),
    );
    attempt.runId = "unqualified-child-source";
    const host = await createAgentHarnessHostCapabilitiesForTest({
      attempt,
      pluginId: "codex",
      nativeModelPolicySupport: "exact",
      operatorSource: {
        profileId: "unqualified-native-operator",
        scopes: ["operator.write"],
        assertCurrent: () => {},
        get modelPolicy() {
          return policy;
        },
        onModelPolicyChanged: (changed) => {
          listeners.add(changed);
          return () => {
            listeners.delete(changed);
          };
        },
      },
    });
    const source = host.capabilities.retainSourceAuthority?.();
    if (!source) {
      throw new Error("Expected host-issued operator source");
    }
    const sibling = source.bindModelExecution?.({ provider: "test-provider", model: "allowed" });
    if (!sibling) {
      throw new Error("Expected sibling model binding");
    }
    const interruptModelExecution = vi.fn();
    const cancelForeground = vi.fn();
    const monitor = new codexNativeSubagentMonitorRuntime.Monitor(client.client, runtime, {
      recoveryPollDelaysMs: [],
      interruptModelExecution,
    });
    const parent = await monitor.registerParent({
      parentThreadId: "parent-thread",
      modelSource: source,
      requesterSessionKey: "agent:main:unqualified-native",
      taskRuntimeScope: createTaskScope("agent:main:unqualified-native"),
      configurationQualification: fresh
        ? undefined
        : { assertCurrent: () => {}, hasProvider: () => false },
      unqualifiedModelExecution: fresh ? true : undefined,
      onUnqualifiedModelCancelled: cancelForeground,
    });
    parent.bindTurn("parent-a");
    const target = threadRead({ threadStatus: "notLoaded" });
    target.thread.modelProvider = "unqualified-provider";
    client.setThreadRead("child-thread", target);
    await notifyChildStarted(client);
    try {
      if (fresh) {
        await client.notify({
          method: "item/completed",
          params: {
            threadId: "parent-thread",
            turnId: "parent-a",
            item: directSpawnItem("v2", "parent-thread", "child-thread"),
          },
        });
      } else {
        await monitor.prepareModelInput({
          threadId: "parent-thread",
          turnId: "parent-a",
          itemId: "accepted-input",
          target: "child-thread",
          readQualification: () => undefined,
          assertCurrent: () => {},
        });
        await client.notify({
          method: "item/completed",
          params: {
            threadId: "parent-thread",
            turnId: "parent-a",
            item: {
              type: "subAgentActivity",
              kind: "interacted",
              id: "accepted-input",
              agentThreadId: "child-thread",
              agentPath: "/root/child-thread",
            },
          },
        });
      }
      await client.notify(turnStartedNotification("unqualified-turn"));
      if (yielded) {
        await parent.unregister();
        host.close();
      }
      policy = {
        models: [{ provider: "test-provider", model: "allowed" }],
        allows: (model) => model.provider === "test-provider" && model.model === "allowed",
      };
      for (const changed of listeners) {
        changed();
      }
      expect(interruptModelExecution).toHaveBeenCalledWith("child-thread", "unqualified-turn");
      if (!yielded) {
        expect(cancelForeground).toHaveBeenCalledOnce();
        expect(interruptModelExecution).toHaveBeenCalledWith("parent-thread", "parent-a");
        await expect(
          monitor.captureModelSource({ threadId: "parent-thread", turnId: "parent-a" }),
        ).rejects.toThrow("execution was cancelled");
        await parent.unregister();
        host.close();
      } else {
        expect(cancelForeground).not.toHaveBeenCalled();
      }
      expect(interruptModelExecution).toHaveBeenCalledTimes(yielded ? 1 : 2);
      expect(sibling.signal.aborted).toBe(false);
      expect(sibling.assertCurrent).not.toThrow();
      const request = {
        threadId: "child-thread",
        turnId: "unqualified-turn",
        parentThreadId: "parent-thread",
        parentTurnId: "parent-a",
      };
      await expect(monitor.captureModelSource(request)).rejects.toThrow("execution was cancelled");
      policy = undefined;
      for (const changed of listeners) {
        changed();
      }
      await expect(monitor.captureModelSource(request)).rejects.toThrow("execution was cancelled");
      await client.notify(
        childTurnCompletedNotification({
          turnId: "unqualified-turn",
          status: "completed",
          items: [{ type: "agentMessage", id: "late-final", text: "Late success" }],
        }),
      );
      expect(runtime.finalizeTaskRunByRunId).toHaveBeenCalledWith(
        expect.objectContaining({ status: "cancelled" }),
      );
    } finally {
      sibling.release();
      monitor.dispose();
      await parent.unregister();
      host.close();
    }
    expect(listeners.size).toBe(0);
  },
);
