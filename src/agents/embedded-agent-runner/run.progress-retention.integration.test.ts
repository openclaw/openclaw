import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { buildAnthropicRequest } from "../../../packages/ai/src/transports/anthropic-messages.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  resetSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import * as transcriptHydration from "../../config/sessions/session-transcript-hydration.js";
import { captureSessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../../gateway/agent-runtime-approval-authority.js";
import { progressCardStore } from "../../gateway/progress-card-store.js";
import { createDirectChatContext } from "../../gateway/server-chat.agent-events.test-helpers.js";
import { createGatewayInstanceRuntime } from "../../gateway/server-instance-runtime.js";
import { createRequestGatewayMethodRegistry } from "../../gateway/server-methods.js";
import {
  loadGatewayModelCatalogSnapshot,
  readPreparedGatewayModelCatalog,
} from "../../gateway/server-model-catalog.js";
import { rotateAgentRunRegistryLifecycleGeneration } from "../../infra/agent-run-registry.js";
import { createAssistantMessageEventStream } from "../../llm/utils/event-stream.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
} from "../../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createColdPluginFixture } from "../../plugins/test-helpers/cold-plugin-fixtures.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { disposeAllSessionMcpRuntimes } from "../agent-bundle-mcp-manager-api.js";
import { bindSessionMcpRuntimeTestScheduler } from "../agent-bundle-mcp-manager.test-support.js";
import { refreshPreparedModelRuntimeSnapshots } from "../prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../prepared-model-runtime.test-support.js";
import type { StreamFn } from "../runtime/index.js";
import { completionModelDefinition } from "../simple-completion.test-support.js";
import { subagentRuns } from "../subagents/registry/subagent-registry-memory.js";
import { observeRootWork } from "../subagents/registry/subagent-registry.browser-cleanup.test-support.js";
import { markSubagentRunTerminated } from "../subagents/registry/subagent-registry.js";
import { settleSubagentRegistryPersistenceWork } from "../subagents/registry/subagent-registry.persistence.test-support.js";
import { resetSubagentRegistryForTests } from "../subagents/registry/subagent-registry.test-helpers.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { createQueuedAssistantStream } from "../test-helpers/assistant-event-stream.test-support.js";
import { runEmbeddedAgent } from "./run.js";
import {
  expectNativeProvenanceRun,
  installNativeProvenanceHooks,
} from "./run.progress-retention-provenance.test-support.js";
import { captureProgressWorkReader } from "./run/progress-work.js";
import * as progressWork from "./run/progress-work.js";
import { clearEmbeddedSessionPromptStates } from "./session-prompt-state.js";
// Script provider I/O and explicit hostile-hook/storage-failure/lifecycle injections;
// native admission, persistence and finalization remain the behavior under test.
it.each([
  "provenance-sql",
  "provenance-plugin",
  "provenance-plugin-repeatable-mutation",
  "provenance-plugin-async",
  "provenance-memory",
  "provenance-rename",
  "provenance-native-failure",
  "provenance-extension-rename",
  "provenance-extension-id",
  "provenance-extension-error",
  "provenance-extension-role",
  "provenance-generation",
  "plugin-search",
  "plugin-search-memory",
  "sql",
  "retry",
  "memory",
  "media",
  "media-failure",
  "media-ack",
  "media-replacement",
  "media-memory",
  "media-reset",
  "media-resave",
  "media-failure-resave",
  "child",
  "child-collector",
  "child-paused",
  "child-fire",
])("%s retains work across routine tools and ordinary outer runs", async (mode) => {
  await withOpenClawTestState(
    { label: "progress-retention", scenario: "minimal" },
    async (state) => {
      const provenance = mode.startsWith("provenance-");
      const pluginSearch = mode.startsWith("plugin-search") || mode.startsWith("provenance-plugin");
      let pluginCalls = 0;
      const nativeMedia = mode.startsWith("media");
      const memoryMode =
        mode === "memory" ||
        mode === "media-memory" ||
        mode === "provenance-memory" ||
        mode === "plugin-search-memory";
      const resave = mode.endsWith("resave");
      const persistenceFailure = mode.startsWith("media-failure");
      const nativeChild = mode.startsWith("child");
      const settleChildWork = nativeChild ? observeRootWork() : undefined;
      const allowedTools = [
        "progress_card",
        pluginSearch ? "search" : "read",
        "image_generate",
        ...(nativeChild ? ["sessions_spawn", "sessions_yield", "agents_wait"] : []),
      ];
      let childCalls = 0;
      let childRunId: string | undefined;
      let finishChild: (() => void) | undefined;
      const sessionId = "progress-retention";
      const sessionKey = memoryMode
        ? "agent:main:dashboard:incognito-retention"
        : "agent:main:progress-retention";
      const plan = [
        { step: "Publish", status: "completed" },
        { step: "Verify CI and merge", status: "pending" },
      ];
      const pluginId = "scripted-retention-provider";
      const bundled = state.path("bundled");
      const rootDir = path.join(bundled, pluginId);
      await fs.mkdir(rootDir, { recursive: true });
      const fixture = createColdPluginFixture({
        rootDir,
        pluginId,
        providerId: "anthropic",
        manifest: {
          channels: [],
          channelConfigs: {},
          providerAuthChoices: [],
          contracts: {
            imageGenerationProviders: ["scripted-image"],
            ...(pluginSearch ? { tools: ["search"] } : {}),
          },
          ...(pluginSearch
            ? {
                toolMetadata: {
                  search: {
                    replaySafe: !mode.startsWith("plugin-search") && mode !== "provenance-plugin",
                    sideEffecting: true,
                  },
                },
              }
            : {}),
        },
      });
      let mediaCalls = 0;
      let finishMedia: (() => void) | undefined;
      const generateImage = async () => {
        mediaCalls++;
        await new Promise<void>((resolve) => {
          finishMedia = resolve;
        });
        throw new Error("Scripted provider interrupted after native lifecycle rotation");
      };
      let turn = 0;
      const requests = [0, 0, 0, 0];
      const readPath = state.path("routine.txt");
      await fs.writeFile(readPath, "Verification remains pending.");
      const firstContexts: string[] = [];
      const toolResults: Array<Parameters<StreamFn>[1]["messages"][number]> = [];
      const stream: StreamFn = async (model, context) => {
        if (provenance) {
          if (model.api !== "anthropic-messages") {
            throw new Error("Unexpected fixture provider");
          }
          const wire = await buildAnthropicRequest(
            { ...model, api: "anthropic-messages" },
            context,
            undefined,
            "provider",
            false,
            false,
          );
          const serialized = JSON.stringify(wire.params.messages);
          expect(serialized).not.toContain("nativeInvocation");
          expect(serialized).not.toContain("processGeneration");
          expect(serialized).not.toContain("sourceEntryId");
        }
        if (nativeChild && context.systemPrompt?.includes("# Subagent Context")) {
          childCalls++;
          const events = createAssistantMessageEventStream();
          const paused = mode === "child-paused";
          const finish = () => {
            const message = makeAgentAssistantMessage({
              api: model.api,
              provider: model.provider,
              model: model.id,
              stopReason: paused ? "toolUse" : "stop",
              content: paused
                ? [
                    {
                      type: "toolCall",
                      id: "child-pause",
                      name: "sessions_yield",
                      arguments: {
                        waitFor: "message",
                        message: "Await requester continuation",
                        acknowledgment: "Waiting for requester",
                      },
                    },
                  ]
                : [{ type: "text", text: "Private child finished" }],
            });
            events.push({ type: "done", reason: paused ? "toolUse" : "stop", message });
            events.end();
          };
          if (paused) {
            queueMicrotask(finish);
          } else {
            finishChild = finish;
          }
          return events;
        }
        const index = (requests[turn] = (requests[turn] ?? 0) + 1) - 1;
        if (index === 0) {
          firstContexts[turn] = JSON.stringify(context.messages);
        }
        toolResults.push(...context.messages.filter((m) => m.role === "toolResult"));
        const args =
          turn === 0 && index < 3
            ? index === 0
              ? { plan }
              : index === 1
                ? { path: mode === "provenance-native-failure" ? readPath + ".missing" : readPath }
                : { markdown: "Published; CI and merge remain authorized." }
            : mode === "child-collector" && turn === 2 && index === 0
              ? { ids: [childRunId], awaitResults: true }
              : mode === "child-collector" && turn === 2 && index === 1
                ? {
                    work: { action: "reconcile", disposition: "completed" },
                    plan: plan.map((step) => ({ ...step, status: "completed" })),
                    markdown: "Published; CI and merge remain authorized.",
                  }
                : nativeChild && turn === 1 && index === 0
                  ? {
                      task: "PRIVATE_NATIVE_CHILD_TASK",
                      context: "isolated",
                      runTimeoutSeconds: 30,
                      ...(mode === "child-collector" ? { collect: true } : {}),
                      ...(mode === "child-fire" ? { expectsCompletionMessage: false } : {}),
                    }
                  : nativeMedia && turn === 1 && index === 0
                    ? { prompt: "A synthetic task illustration" }
                    : nativeMedia && resave && turn === 1 && index < 3
                      ? index === 1
                        ? { plan }
                        : { markdown: "Published; CI and merge remain authorized." }
                      : turn === 3 && index === 0
                        ? {
                            work: { action: "reconcile", disposition: "actionable" },
                            markdown: "Published; CI and merge remain authorized.",
                          }
                        : undefined;
        const message = makeAgentAssistantMessage({
          api: model.api,
          provider: model.provider,
          model: model.id,
          stopReason: args ? "toolUse" : "stop",
          content: args
            ? [
                {
                  type: "toolCall",
                  id:
                    turn === 3
                      ? "current-reconcile"
                      : index === 0
                        ? "save-plan"
                        : index === 1
                          ? "routine-read"
                          : "save-note",
                  name:
                    mode === "child-collector" && turn === 2
                      ? index === 0
                        ? "agents_wait"
                        : "progress_card"
                      : nativeChild && turn === 1
                        ? "sessions_spawn"
                        : nativeMedia && turn === 1 && index === 0
                          ? "image_generate"
                          : turn === 0 && index === 1
                            ? pluginSearch
                              ? "search"
                              : "read"
                            : "progress_card",
                  arguments: args,
                },
              ]
            : mode === "retry" && turn === 1 && index === 0
              ? []
              : [{ type: "text", text: "Published; verification and landing remain." }],
        });
        return createQueuedAssistantStream((push) =>
          push({ type: "done", reason: args ? "toolUse" : "stop", message }),
        );
      };
      const bridgeKey = "__retention_provider_" + path.basename(state.root);
      Object.defineProperty(globalThis, bridgeKey, {
        configurable: true,
        value: {
          stream,
          generateImage,
          search: async () => {
            pluginCalls++;
            return {
              content: [{ type: "text", text: "Native plugin effect finished" }],
              details: {
                finished: true,
                ...(mode === "provenance-plugin-async" ? { async: true, status: "started" } : {}),
              },
            };
          },
        },
      });
      await fs.writeFile(
        fixture.runtimeSource,
        "module.exports = { id: " +
          JSON.stringify(pluginId) +
          ', register(api) { api.registerProvider({ id: "anthropic", label: "Scripted", auth: [], wrapStreamFn: () => globalThis[' +
          JSON.stringify(bridgeKey) +
          "].stream }); api.registerImageGenerationProvider({ id: 'scripted-image', defaultModel: 'image', models: ['image'], capabilities: { generate: { maxCount: 1 }, edit: { enabled: false } }, isConfiguredAsync: async () => true, generateImage: globalThis[" +
          JSON.stringify(bridgeKey) +
          "].generateImage }); " +
          (pluginSearch
            ? "api.registerTool({ name: 'search', description: 'Synthetic side-effecting plugin search', parameters: { type: 'object', properties: { path: { type: 'string' } } }, execute: globalThis[" +
              JSON.stringify(bridgeKey) +
              "].search });"
            : "") +
          " } };",
      );
      const provenanceHooks = provenance ? installNativeProvenanceHooks(mode) : undefined;
      const network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        throw new Error("Unexpected network I/O");
      });
      const config: OpenClawConfig = {
        agents: {
          entries: { main: { agentDir: state.agentDir(), workspace: state.workspaceDir } },
          defaults: {
            workspace: state.workspaceDir,
            model: "anthropic/claude-opus-5",
            mediaModels: { image: { primary: "scripted-image/image" } },
          },
        },
        models: {
          mode: "replace",
          providers: {
            anthropic: {
              api: "anthropic-messages",
              auth: "api-key",
              apiKey: "synthetic-retention-key",
              baseUrl: "https://api.anthropic.com",
              models: [completionModelDefinition({ id: "claude-opus-5", contextWindow: 200_000 })],
            },
          },
        },
        plugins: {
          allow: [pluginId],
          slots: { memory: "none" },
          entries: { [pluginId]: { enabled: true } },
        },
        tools: {
          allow: allowedTools,
          toolSearch: false,
          ...(nativeChild ? { swarm: { enabled: true, maxConcurrent: 1 } } : {}),
        },
        skills: { load: { watch: false } },
      };
      await state.writeConfig(config);
      try {
        await withEnvAsync(
          { OPENCLAW_BUNDLED_PLUGINS_DIR: bundled, OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined },
          async () => {
            await resetPreparedModelRuntimeSnapshotsForTest();
            clearPluginMetadataLifecycleCaches();
            setRuntimeConfigSnapshot(config);
            const target = {
              agentId: "main",
              sessionId,
              sessionKey,
              storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
            };
            await upsertSessionEntryCore(target, {
              sessionId,
              updatedAt: 1,
              ...(memoryMode ? { incognito: true } : {}),
            });
            const execution = new AsyncWorkScope();
            const gateway = createDirectChatContext({
              getRuntimeConfig: () => config,
              trackExecution: (run) => execution.track(run),
            });
            let nativeRuntime: ReturnType<typeof createGatewayInstanceRuntime> | undefined;
            if (nativeChild) {
              await bindSessionMcpRuntimeTestScheduler();
              await resetSubagentRegistryForTests({ persist: false });
              await refreshPreparedModelRuntimeSnapshots(config, {
                gatewayLifecycle: true,
                catalogMode: "static",
                allowGatewaySubagentBinding: true,
                defaultWorkspaceDir: state.workspaceDir,
              });
              gateway.addChatRun = gateway.chatRunState.registry.add;
              gateway.removeChatRun = gateway.chatRunState.registry.remove;
              gateway.loadGatewayModelCatalogSnapshot = (request) =>
                loadGatewayModelCatalogSnapshot({ ...request, getConfig: () => config });
              gateway.loadGatewayModelCatalog = async (request) =>
                (await gateway.loadGatewayModelCatalogSnapshot(request)).entries;
              gateway.readPreparedGatewayModelCatalog = (request) =>
                readPreparedGatewayModelCatalog({ ...request, getConfig: () => config });
              gateway.validateAgentRuntimeApprovalAuthority =
                createAgentRuntimeApprovalAuthorityValidator();
              const methods = createRequestGatewayMethodRegistry();
              nativeRuntime = createGatewayInstanceRuntime({
                getContext: () => gateway,
                getMethodRegistry: () => methods,
                isDispatchAvailable: () => true,
              });
              gateway.createAgentTurnFacade = nativeRuntime.createAgentTurnFacade;
              gateway.lifecycleRuntime = nativeRuntime.lifecycle;
              gateway.getGatewayMethodRegistry = () => methods;
            }
            let waitingWrites = 0;
            const put = progressCardStore.put.bind(progressCardStore);
            const waitingFault = vi
              .spyOn(progressCardStore, "put")
              .mockImplementation(async (key, input, agent) => {
                if (input.managedWork?.acceptedWait) {
                  waitingWrites++;
                  if (mode === "media-reset") {
                    await resetSessionEntryLifecycle({
                      agentId: "main",
                      storePath: target.storePath,
                      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
                      resetBoundary: { context: "clear", reason: "reset", cwd: state.workspaceDir },
                      buildNextEntry: (entry) => ({
                        ...entry!,
                        sessionId,
                        lifecycleRevision: "reset-during-native-wait",
                        updatedAt: Date.now(),
                      }),
                    });
                  }
                  if (persistenceFailure) {
                    throw new Error("Waiting persistence unavailable");
                  }
                  if (mode === "media-replacement") {
                    await put(
                      key,
                      {
                        workCommand: {
                          kind: "replace",
                          owner: input.managedWork.owner,
                          source: { ...input.managedWork.source, toolCallId: "replacement-wins" },
                          expected: input.managedWork.expected,
                          scope: "Replacement before waiting commit",
                        },
                        steps: [{ step: "New obligation", status: "pending" }],
                      },
                      agent,
                    );
                  }
                  const committed = await put(key, input, agent);
                  if (mode === "media-ack") {
                    throw new Error("Waiting commit acknowledgement lost");
                  }
                  return committed;
                }
                return put(key, input, agent);
              });
            try {
              for (
                turn = 0;
                turn <
                (provenance
                  ? 1
                  : pluginSearch || mode === "retry"
                    ? 2
                    : mode === "child-collector"
                      ? 3
                      : nativeChild
                        ? 2
                        : 4);
                turn++
              ) {
                if (mode === "child-collector" && turn === 2) {
                  finishChild?.();
                  await vi.waitFor(
                    () =>
                      expect(subagentRuns.get(childRunId!)?.collectorCompletion?.status).toBe(
                        "done",
                      ),
                    { timeout: 15000 },
                  );
                }
                if (turn === 2 && !nativeChild) {
                  rotateAgentRunRegistryLifecycleGeneration();
                  finishMedia?.();
                }
                const runId = "progress-retention-" + mode + "-" + turn;
                const admission = prepareSystemAgentRunAdmission(
                  config,
                  runId,
                  "main",
                  "retention-test",
                );
                let initialReads = 0;
                const capture = progressWork.captureProgressWorkReader;
                const hydrationCount =
                  mode === "retry" && turn === 1
                    ? vi
                        .spyOn(progressWork, "captureProgressWorkReader")
                        .mockImplementation((input) => {
                          const reader = capture(input);
                          return {
                            ...reader,
                            read: async () => {
                              initialReads++;
                              return reader.read();
                            },
                          };
                        })
                    : undefined;
                try {
                  const result = await withPluginRuntimeGatewayRequestScope(
                    { context: gateway, isWebchatConnect: () => false },
                    () =>
                      runEmbeddedAgent({
                        preparedRunAdmission: admission,
                        config,
                        runId,
                        sessionId,
                        sessionKey,
                        agentId: "main",
                        agentDir: state.agentDir(),
                        workspaceDir: state.workspaceDir,
                        sessionTarget: target,
                        provider: "anthropic",
                        model: "claude-opus-5",
                        prompt:
                          turn === 0
                            ? "Publish, verify CI and merge. A status note does not cancel work."
                            : "What is the status? Continue the authorized work; this is not a pause.",
                        toolsAllow: allowedTools,
                        cleanupBundleMcpOnRunEnd: true,
                        timeoutMs: 30_000,
                      }),
                  );
                  if (mode === "retry" && turn === 1) {
                    expect(hydrationCount).toHaveBeenCalledOnce();
                    expect(initialReads).toBe(2); // Initial hydration and one final coverage refresh, not a new reader on retry.
                    expect(requests[turn]).toBe(3);
                    console.log(
                      "RETENTION_RETRY",
                      JSON.stringify({
                        captures: hydrationCount?.mock.calls.length,
                        reads: initialReads,
                        requests: requests[turn],
                        error: result.meta.error,
                      }),
                    );
                  }
                  if (mode === "child-collector" && turn === 2) {
                    const collected = toolResults.findLast(
                      (r) => r.role === "toolResult" && r.toolName === "agents_wait",
                    );
                    expect(collected).toMatchObject({ isError: false });
                    if (!collected || collected.role !== "toolResult") {
                      throw new Error("Missing native collection");
                    }
                    const payload = collected.content.find((part) => part.type === "text");
                    if (payload?.type !== "text") {
                      throw new Error("Missing collection result");
                    }
                    expect(JSON.parse(payload.text)).toMatchObject({
                      completed: [
                        { runId: childRunId, status: "done", result: "Private child finished" },
                      ],
                      pending: [],
                    });
                    expect(childCalls).toBe(1);
                    const work = await captureProgressWorkReader({
                      target: captureSessionTranscriptTargetBinding(target),
                      assertCurrent() {},
                    }).read();
                    expect(work).toMatchObject({
                      kind: "retained",
                      state: {
                        record: {
                          disposition: { kind: "completed" },
                          steps: [{ status: "completed" }, { status: "completed" }],
                        },
                      },
                    });
                    expect(requests[turn]).toBe(3);
                    expect(network).not.toHaveBeenCalled();
                    return;
                  }
                  if (mode === "media-reset" && turn === 1) {
                    expect(waitingWrites).toBe(1);
                    expect(result.meta.error).toMatchObject({
                      kind: "incomplete_turn",
                      fallbackSafe: false,
                      terminalPresentation: false,
                    });
                    expect(await progressCardStore.get(sessionKey, "main")).toBeNull();
                    const resetWork = await captureProgressWorkReader({
                      target: {
                        ...captureSessionTranscriptTargetBinding(target),
                        expectedLifecycleRevision: "reset-during-native-wait",
                      },
                      assertCurrent() {},
                    }).read();
                    expect(resetWork).toMatchObject({ kind: "retained", state: { record: null } });
                    // The native operation was accepted before this bookkeeping write; reset retires work, not that external effect.
                    expect(mediaCalls).toBe(1);
                    console.log(
                      "RETENTION_NATIVE_RESET",
                      JSON.stringify({
                        waitingWrites,
                        mediaCalls,
                        resetWork,
                        resultError: result.meta.error,
                      }),
                    );
                    return;
                  }
                  expect(result.meta.error).toBeUndefined();
                  if (nativeMedia && (turn === 1 || turn === 2)) {
                    const snapshot = await captureProgressWorkReader({
                      target: captureSessionTranscriptTargetBinding(target),
                      assertCurrent() {},
                    }).read();
                    expect(snapshot).toMatchObject({
                      kind: "retained",
                      state: {
                        record: {
                          disposition:
                            persistenceFailure || mode === "media-replacement"
                              ? { kind: "actionable" }
                              : { kind: "waiting", receipt: { kind: "media" } },
                        },
                      },
                    });
                    if (persistenceFailure || mode === "media-replacement") {
                      expect(snapshot).toMatchObject({ coverage: { kind: "unavailable" } });
                    }
                    if (mode === "media-replacement") {
                      expect(snapshot).toMatchObject({
                        state: {
                          generation: 2,
                          record: { scope: "Replacement before waiting commit" },
                        },
                      });
                    }
                    expect(waitingWrites).toBe(1);
                    expect(mediaCalls).toBe(1);
                  }
                  if (nativeChild && turn === 1) {
                    const accepted = [...subagentRuns.values()].filter(
                      (row) => row.requesterSessionKey === sessionKey,
                    );
                    expect(accepted).toHaveLength(1);
                    const child = accepted[0]!;
                    childRunId = child.runId;
                    await vi.waitFor(
                      () => {
                        const current = subagentRuns.get(child.runId);
                        if (current?.execution.status === "terminal" && childCalls === 0) {
                          throw new Error(
                            "Private child ended before provider entry: " + JSON.stringify(current),
                          );
                        }
                        expect(childCalls).toBe(1);
                      },
                      { timeout: 10000 },
                    );
                    if (mode === "child-paused") {
                      await vi.waitFor(
                        () =>
                          expect(subagentRuns.get(child.runId)?.pauseReason).toBe("sessions_yield"),
                        { timeout: 10000 },
                      );
                    }
                    const work = await captureProgressWorkReader({
                      target: captureSessionTranscriptTargetBinding(target),
                      assertCurrent() {},
                    }).read();
                    expect(work).toMatchObject({
                      kind: "retained",
                      state: {
                        record: {
                          disposition:
                            mode === "child-fire"
                              ? { kind: "actionable" }
                              : {
                                  kind: "waiting",
                                  receipt: {
                                    kind: "child",
                                    runId: child.runId,
                                    childSessionKey: child.childSessionKey,
                                  },
                                },
                        },
                      },
                    });
                    expect(waitingWrites).toBe(mode === "child-fire" ? 0 : 1);
                    expect(work).toMatchObject({
                      state: {
                        record: {
                          owner: {
                            agentId: "main",
                            sessionKey,
                            sessionId,
                            lifecycleRevision: null,
                          },
                        },
                      },
                      coverage: { kind: "unavailable" },
                    });
                    if (mode !== "child-fire") {
                      expect(work).toMatchObject({
                        state: {
                          record: {
                            disposition: {
                              source: {
                                runId,
                                toolCallId: "save-plan",
                                turnId: expect.any(String),
                              },
                            },
                          },
                        },
                      });
                    }
                    expect(child.collect === true).toBe(mode === "child-collector");
                    console.log(
                      "RETENTION_NATIVE_CHILD",
                      JSON.stringify({
                        mode,
                        runId: child.runId,
                        childSessionKey: child.childSessionKey,
                        childCalls,
                        waitingWrites,
                        work,
                      }),
                    );
                  }
                  if (provenance) {
                    await expectNativeProvenanceRun({
                      mode,
                      runId,
                      target,
                      workspace: state.workspaceDir,
                      hooks: provenanceHooks!,
                      pluginOwned: pluginSearch,
                    });
                    expect(pluginCalls).toBe(pluginSearch ? 1 : 0);
                    expect(network).not.toHaveBeenCalled();
                    return;
                  }
                  if (pluginSearch) {
                    expect(pluginCalls).toBe(1);
                    expect(toolResults).toContainEqual(
                      expect.objectContaining({
                        role: "toolResult",
                        toolName: "search",
                        isError: false,
                      }),
                    );
                    const work = await captureProgressWorkReader({
                      target: captureSessionTranscriptTargetBinding(target),
                      assertCurrent() {},
                    }).read();
                    const hydration = transcriptHydration.prepareSessionTranscriptHydration(
                      captureSessionTranscriptTargetBinding(target),
                      { maxBytes: 262_144, maxEvents: 256 },
                    );
                    const history = await hydration.read();
                    hydration.assertCurrent();
                    expect(history.kind).toBe("bounded");
                    expect(JSON.stringify(history)).not.toContain("nested-tool");
                    console.log(
                      "RETENTION_DIRECT_PLUGIN",
                      JSON.stringify({ turn, pluginCalls, requests: requests[turn], work }),
                    );
                    expect
                      .soft(work)
                      .toMatchObject({ kind: "retained", coverage: { kind: "unavailable" } });
                    expect.soft(requests[turn]).toBe(turn === 0 ? 4 : 1);
                    expect(work).toMatchObject({
                      state: { record: { steps: plan, disposition: { kind: "actionable" } } },
                    });
                    expect(
                      result.payloads?.some((payload) =>
                        payload.text?.includes("Published; verification and landing remain."),
                      ),
                    ).toBe(true);
                    if (turn === 1) {
                      expect(network).not.toHaveBeenCalled();
                      return;
                    }
                    continue;
                  }
                  const card = await progressCardStore.get(sessionKey, "main");
                  expect(card?.markdown).toBe("Published; CI and merge remain authorized.");
                  expect(card?.steps).toBeUndefined();
                  console.log(
                    "RETENTION_OUTER " +
                      JSON.stringify({ mode, turn, requests: requests[turn], card }),
                  );
                  expect
                    .soft(
                      requests[turn],
                      turn === 0
                        ? "note-only display must retain work"
                        : "ordinary next run must hydrate work",
                    )
                    .toBe(
                      turn === 0
                        ? 5
                        : mode === "retry"
                          ? 3
                          : turn === 1
                            ? resave
                              ? 4
                              : 2
                            : turn === 2
                              ? 1
                              : 3,
                    );
                } finally {
                  hydrationCount?.mockRestore();
                  admission.close();
                }
              }
              if (nativeChild || mode === "retry") {
                return;
              }
              expect(firstContexts[1]).toContain("Retained task context");
              expect(firstContexts[1]).toContain("Verify CI and merge");
              expect(firstContexts[1]).toContain("bounded-no-handoff");
              expect(firstContexts[2]).toContain(
                mode === "media-replacement" ? "New obligation" : "Verify CI and merge",
              );
              expect(firstContexts[2]).toContain("Native process/lifecycle changed");
              expect(toolResults.length).toBeGreaterThan(0);
              expect(toolResults.some((r) => r.role === "toolResult" && r.isError)).toBe(false);
              // The barrier delays a real bounded read, not its data or the write owner.
              const captured = captureProgressWorkReader({
                target: captureSessionTranscriptTargetBinding(target),
                assertCurrent() {},
              });
              const before = await captured.read();
              expect(before.kind).toBe("retained");
              if (before.kind !== "retained" || !before.state.record) {
                throw new Error("Missing task");
              }
              const previous = before.state;
              for (const transition of ["replace", "reset"] as const) {
                const prepare = transcriptHydration.prepareSessionTranscriptHydration;
                let applied = false;
                const barrier = vi
                  .spyOn(transcriptHydration, "prepareSessionTranscriptHydration")
                  .mockImplementation((...args) => {
                    const hydration = prepare(...args);
                    return {
                      ...hydration,
                      read: async (options) => {
                        const value = await hydration.read(options);
                        if (!applied) {
                          applied = true;
                          if (transition === "replace") {
                            await progressCardStore.put(
                              sessionKey,
                              {
                                steps: [{ step: "Replacement obligation", status: "pending" }],
                                workCommand: {
                                  kind: "replace",
                                  owner: captured.owner,
                                  source: {
                                    ...previous.record!.source,
                                    toolCallId: "replacement-during-observation",
                                  },
                                  expected: {
                                    generation: previous.generation,
                                    revision: previous.revision,
                                  },
                                  scope: "Replacement obligation",
                                },
                              },
                              "main",
                            );
                          } else {
                            await resetSessionEntryLifecycle({
                              agentId: "main",
                              storePath: target.storePath,
                              target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
                              resetBoundary: {
                                context: "clear",
                                reason: "reset",
                                cwd: state.workspaceDir,
                              },
                              buildNextEntry: (entry) => ({
                                ...entry!,
                                sessionId,
                                lifecycleRevision: "reset-after-read",
                                updatedAt: Date.now(),
                              }),
                            });
                          }
                        }
                        return value;
                      },
                    };
                  });
                try {
                  const observed = await captured.read();
                  expect(applied).toBe(true);
                  if (transition === "replace") {
                    expect(observed).toMatchObject({
                      kind: "retained",
                      state: {
                        generation: previous.generation + 1,
                        record: { scope: "Replacement obligation" },
                      },
                      coverage: {
                        kind: "unavailable",
                        reason: "Retained work changed during execution observation",
                      },
                    });
                  } else {
                    expect(observed.kind).toBe("unavailable");
                    expect(await progressCardStore.get(sessionKey, "main")).toBeNull();
                  }
                } finally {
                  barrier.mockRestore();
                }
              }
              expect(network).not.toHaveBeenCalled();
            } finally {
              waitingFault.mockRestore();
              if (nativeChild) {
                for (const child of subagentRuns.values()) {
                  if (child.requesterSessionKey === sessionKey) {
                    await markSubagentRunTerminated({
                      runId: child.runId,
                      reason: "private fixture cleanup",
                    });
                  }
                }
                finishChild?.();
                execution.beginClose();
                await vi.waitFor(() => expect(execution.hasPendingWork).toBe(false), {
                  timeout: 20000,
                });
                await execution.drain();
                await settleSubagentRegistryPersistenceWork(() => settleChildWork!());
                nativeRuntime?.close();
                await disposeAllSessionMcpRuntimes();
                await resetSubagentRegistryForTests({ persist: false });
              }
              await resetPreparedModelRuntimeSnapshotsForTest();
              resetPluginLoaderTestStateForTest();
              cleanupPluginLoaderFixturesForTest();
              clearPluginMetadataLifecycleCaches();
            }
          },
        );
      } finally {
        // Failure cleanup revokes this private provider before releasing it; no completion wake escapes the fixture.
        if (finishMedia && turn < 2) {
          rotateAgentRunRegistryLifecycleGeneration();
        }
        finishMedia?.();
        provenanceHooks?.restore();
        network.mockRestore();
        clearEmbeddedSessionPromptStates([sessionId]);
        Reflect.deleteProperty(globalThis, bridgeKey);
      }
    },
  );
});
