import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getAiTransportHost, type AssistantMessage, type Model } from "@openclaw/ai";
import { createAssistantMessageEventStream } from "@openclaw/ai/event-stream";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { validateConfigObjectRaw } from "../../config/validation-core.js";
import { delegateCompactionToRuntime } from "../../context-engine/delegate.js";
import { initializeGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
} from "../../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { createColdPluginFixture } from "../../plugins/test-helpers/cold-plugin-fixtures.js";
import {
  AsyncWorkScope,
  captureAsyncWorkTracker,
  trackAsyncWork,
} from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../prepared-model-runtime.test-support.js";
import type { StreamFn } from "../runtime/index.js";
import type { AgentSession } from "../sessions/agent-session.js";
import { createEventBus } from "../sessions/event-bus.js";
import { loadExtensionFromFactory } from "../sessions/extensions/loader.js";
import type { ExtensionContext } from "../sessions/extensions/types.js";
import { SessionManager } from "../sessions/session-manager.js";
import { recordSessionModelUsage } from "../sessions/session-model-usage.js";
import { attachCompactionAccountingRecorder } from "./run/compaction-accounting-bridge.js";

type Mode =
  | "success"
  | "abort-before-commit"
  | "abort-after-commit"
  | "automatic-after-commit"
  | "timeout-after-commit"
  | "session-hook-tail"
  | "provider-tail"
  | "cleanup-tail"
  | "preparation-failure"
  | "before_compaction"
  | "after_compaction"
  | "raw";
type Connection = { file: string; database: DatabaseSync; disposals: number };
type Fixture = {
  mode: Mode;
  root: string;
  source?: Connection;
  registrations: Connection[];
  tools: Connection[];
  entered: ReturnType<typeof createDeferredCore<void>>;
  finish: ReturnType<typeof createDeferredCore<void>>;
  pending: Promise<unknown>[];
  eventBus: ReturnType<typeof createEventBus>;
  session?: AgentSession;
  context?: ExtensionContext;
  disposals: number;
  envRestored: boolean;
  lateReads: number;
};
const active = vi.hoisted(() => ({ fixture: undefined as Fixture | undefined }));
const providerId = "delegate-resource-provider";
const summary = "The deployment checklist was reviewed. Compare the remaining rollout options.";

function fixture(): Fixture {
  return expectDefined(active.fixture, "active delegate fixture");
}

// RUN ownership is not activated here. Supply the existing managed read-only
// producer to the real delegate, leaving selection, sessions, and disposal intact.
vi.mock("../prepared-model-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../prepared-model-runtime.js")>();
  return {
    ...actual,
    acquireAgentRunPreparedModelRuntime: async (
      input: Parameters<typeof actual.acquireAgentRunPreparedModelRuntime>[0],
      options: Parameters<typeof actual.acquireAgentRunPreparedModelRuntime>[1],
    ) => {
      const current = fixture();
      const lease =
        current.mode === "raw"
          ? await actual.acquireAgentRunPreparedModelRuntime(input, options)
          : await actual.acquireReadOnlyPreparedModelRuntime(
              {
                ...input,
                readOnly: true,
                loadRuntimePlugins: true,
                runtimePluginSelections: [
                  { provider: providerId, modelId: "model", agentId: "main" },
                ],
              },
              options?.abortSignal,
              "static",
            );
      expect(current.registrations.length).toBe(1);
      if (current.mode === "before_compaction" || current.mode === "after_compaction") {
        expect(
          lease.snapshot.pluginRegistry?.typedHooks.filter((hook) => hook.hookName === current.mode)
            .length,
        ).toBe(1);
      }
      current.source = expectDefined(current.registrations[0], "selected registration");
      return lease;
    },
  };
});

function remember(current: Fixture, pending: Promise<unknown>) {
  current.pending.push(pending);
  void pending.catch(() => {});
  return pending;
}

async function hold(current: Fixture, readTools = true) {
  current.entered.resolve();
  await current.finish.promise;
  const source = expectDefined(current.source, "acquired registration");
  expect(source.database.prepare("SELECT value FROM answer").get()?.value).toBe(42);
  for (const tool of readTools ? current.tools : []) {
    expect(tool.database.prepare("SELECT value FROM answer").get()?.value).toBe(42);
  }
  current.lateReads++;
}

vi.mock("../sessions/sdk.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sessions/sdk.js")>();
  return {
    ...actual,
    createAgentSessionForEmbeddedRunner: async (
      options: Parameters<typeof actual.createAgentSessionForEmbeddedRunner>[0],
      internalOptions: Parameters<typeof actual.createAgentSessionForEmbeddedRunner>[1],
    ) => {
      const current = fixture();
      const extensions = expectDefined(
        options.resourceLoader,
        "real resource loader",
      ).getExtensions();
      extensions.extensions.push(
        await loadExtensionFromFactory(
          (api) => {
            api.on("session_before_compact", async (event, context) => {
              current.context = context;
              if (current.mode === "abort-before-commit") {
                await remember(current, hold(current));
                return {
                  compaction: {
                    summary,
                    firstKeptEntryId: event.preparation.firstKeptEntryId,
                    tokensBefore: event.preparation.tokensBefore,
                  },
                };
              }
              return undefined;
            });
            api.on("session_compact", async () => {
              if (
                current.mode === "abort-after-commit" ||
                current.mode === "automatic-after-commit" ||
                current.mode === "timeout-after-commit"
              ) {
                await remember(current, hold(current));
              } else if (current.mode === "session-hook-tail") {
                void remember(
                  current,
                  trackAsyncWork(() => hold(current)),
                );
              }
            });
          },
          options.cwd ?? current.root,
          current.eventBus,
          extensions.runtime,
        ),
      );
      const created = await actual.createAgentSessionForEmbeddedRunner(options, internalOptions);
      current.session = created.session;
      const dispose = created.session.dispose.bind(created.session);
      vi.spyOn(created.session, "dispose").mockImplementation(() => {
        current.disposals++;
        dispose();
      });
      return created;
    },
  };
});

function assistant(model: Model, text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: "stop",
    timestamp: 1,
    usage: {
      input: 100,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 120,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

vi.mock("./stream-resolution.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./stream-resolution.js")>();
  return {
    ...actual,
    resolveEmbeddedAgentStream: (
      params: Parameters<typeof actual.resolveEmbeddedAgentStream>[0],
    ) => {
      const resolved = actual.resolveEmbeddedAgentStream(params);
      const streamFn: StreamFn = (model) => {
        const current = fixture();
        if (current.mode === "provider-tail") {
          const pending = remember(current, hold(current));
          expectDefined(
            getAiTransportHost().observePendingProviderWork,
            "provider work observer",
          )(pending);
        }
        const result = createAssistantMessageEventStream();
        result.push({ type: "done", reason: "stop", message: assistant(model, summary) });
        result.end();
        return result;
      };
      return { ...resolved, streamFn };
    },
  };
});

function openTool(current: Fixture, name: string): Connection {
  const file = path.join(current.root, `${name}.sqlite`);
  const database = new DatabaseSync(file);
  database.exec("CREATE TABLE answer(value INTEGER); INSERT INTO answer VALUES (42)");
  const connection = { file, database, disposals: 0 };
  current.tools.push(connection);
  return connection;
}

// These real SQLite handles stand at the existing MCP/LSP factory boundary;
// this fixture tests runtime custody, not either wire protocol.
vi.mock("../agent-bundle-mcp-tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent-bundle-mcp-tools.js")>()),
  createBundleMcpToolRuntime: async () => {
    const current = fixture();
    const connection = openTool(current, "mcp");
    const track = captureAsyncWorkTracker();
    if (current.mode === "preparation-failure") {
      void remember(
        current,
        track(() => hold(current)),
      );
    }
    return {
      tools: [],
      dispose: async () => {
        if (current.mode === "cleanup-tail") {
          void remember(
            current,
            track(() => hold(current, false)),
          );
        }
        connection.disposals++;
        connection.database.close();
      },
    };
  },
}));

vi.mock("../agent-bundle-lsp-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent-bundle-lsp-runtime.js")>()),
  createBundleLspToolRuntime: async () => {
    const current = fixture();
    if (current.mode === "preparation-failure") {
      throw new Error("fixture LSP setup failed");
    }
    const connection = openTool(current, "lsp");
    return {
      tools: [],
      sessions: [],
      dispose: async () => {
        connection.disposals++;
        connection.database.close();
      },
    };
  },
}));

vi.mock("./skill-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./skill-runtime.js")>();
  return {
    ...actual,
    prepareEmbeddedSkills: (params: Parameters<typeof actual.prepareEmbeddedSkills>[0]) => {
      const prepared = actual.prepareEmbeddedSkills(params);
      const current = fixture();
      return {
        ...prepared,
        restoreSkillEnv: () => {
          prepared.restoreSkillEnv();
          current.envRestored = true;
        },
      };
    },
  };
});

describe("delegate compaction resource retirement", () => {
  it.each<Mode>([
    "success",
    "abort-before-commit",
    "abort-after-commit",
    "automatic-after-commit",
    "timeout-after-commit",
    "session-hook-tail",
    "provider-tail",
    "cleanup-tail",
    "preparation-failure",
    "before_compaction",
    "after_compaction",
    "raw",
  ])(
    "keeps actual work owned through %s",
    async (mode) => {
      await withOpenClawTestState(
        { label: "delegate-resources", layout: "split" },
        async (state) => {
          const current: Fixture = {
            mode,
            root: state.root,
            registrations: [],
            tools: [],
            entered: createDeferredCore(),
            finish: createDeferredCore(),
            pending: [],
            eventBus: createEventBus(),
            disposals: 0,
            envRestored: false,
            lateReads: 0,
          };
          active.fixture = current;
          const pluginRoot = state.path("plugin");
          const emptyBundled = state.path("empty-bundled");
          fs.mkdirSync(pluginRoot);
          fs.mkdirSync(emptyBundled);
          const plugin = createColdPluginFixture({
            rootDir: pluginRoot,
            pluginId: providerId,
            providerId,
            manifest: { channels: [], channelConfigs: {}, providerAuthChoices: [] },
          });
          const key = `__delegate_resources_${path.basename(state.root)}`;
          const bridge = {
            connections: current.registrations,
            hold: () => remember(current, hold(current)),
          };
          Object.defineProperty(globalThis, key, { configurable: true, value: bridge });
          fs.writeFileSync(
            plugin.runtimeSource,
            `
const { DatabaseSync } = require("node:sqlite");
module.exports = { id: ${JSON.stringify(providerId)}, register(api) {
  const bridge = globalThis[${JSON.stringify(key)}];
  const file = ${JSON.stringify(state.root)} + "/registration-" + bridge.connections.length + ".sqlite";
  const database = new DatabaseSync(file);
  database.exec("CREATE TABLE answer(value INTEGER); INSERT INTO answer VALUES (42)");
  const connection = { file, database, disposals: 0 };
  bridge.connections.push(connection);
  api.lifecycle.registerRuntimeLifecycle({ id: "database", dispose() {
    connection.disposals++;
    database.close();
  } });
  api.registerProvider({ id: ${JSON.stringify(providerId)}, label: "Fixture provider", auth: [] });
  ${
    mode === "before_compaction" || mode === "after_compaction"
      ? `api.on(${JSON.stringify(mode)}, async () => {
    await bridge.hold();
    database.prepare("SELECT value FROM answer").get();
  }, { timeoutMs: 25 });`
      : ""
  }
} };
`,
          );
          const configuredModel = {
            id: "model",
            name: "Fixture model",
            api: "openai-completions",
            baseUrl: "https://fixture.invalid/v1",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128_000,
            maxTokens: 1_024,
          } satisfies ModelDefinitionConfig;
          const model = { ...configuredModel, provider: providerId };
          const config: OpenClawConfig = {
            session: { store: state.path("transcripts", "openclaw-agent.sqlite") },
            agents: {
              ownership: "explicit",
              entries: { main: {} },
              defaults: {
                workspace: state.workspaceDir,
                model: { primary: `${providerId}/model` },
                compaction: {
                  mode: "default",
                  keepRecentTokens: 1,
                  postIndexSync: "off",
                  timeoutSeconds: mode === "timeout-after-commit" ? 1 : 180,
                },
              },
            },
            models: {
              providers: {
                [providerId]: {
                  api: "openai-completions",
                  apiKey: "fixture-key",
                  baseUrl: model.baseUrl,
                  agentRuntime: { id: "openclaw" },
                  models: [configuredModel],
                },
              },
            },
            plugins: {
              allow: [providerId],
              load: { paths: [pluginRoot] },
              slots: { memory: "none" },
              entries: {
                [providerId]: { enabled: true, hooks: { allowConversationAccess: true } },
              },
            },
          };
          const validation = validateConfigObjectRaw(config);
          expect(
            validation.ok,
            validation.ok ? "" : validation.issues.map((issue) => issue.path).join(", "),
          ).toBe(true);
          const target = {
            agentId: "main",
            sessionId: "delegate-session",
            sessionKey: "agent:main:delegate-session",
            storePath: state.path("transcripts", "openclaw-agent.sqlite"),
          };
          await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
          const manager = SessionManager.open(target, state.workspaceDir);
          manager.appendModelChange(model.provider, model.id);
          manager.appendThinkingLevelChange("off");
          for (const text of [
            "Review the deployment checklist.",
            "Compare the remaining options.",
            "Keep the rollout notes.",
          ]) {
            manager.appendMessage({ role: "user", content: text, timestamp: 1 });
            manager.appendMessage(assistant(model, `Recorded: ${text}`));
          }
          manager.flushPendingPersistence();
          const runtimeContext = {
            workspaceDir: state.workspaceDir,
            provider: providerId,
            model: "model",
            trigger: mode === "automatic-after-commit" ? "overflow" : "manual",
            thinkLevel: "off",
            config,
          };
          const recordUsage = vi.fn();
          const recordCompaction = vi.fn();
          attachCompactionAccountingRecorder(runtimeContext, { recordUsage, recordCompaction });
          const parent = new AsyncWorkScope();
          const controller = new AbortController();
          let operation: ReturnType<typeof delegateCompactionToRuntime> | undefined;
          let drained: Promise<void> | undefined;
          await withEnvAsync(
            { OPENCLAW_BUNDLED_PLUGINS_DIR: emptyBundled, OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
            async () => {
              await resetPreparedModelRuntimeSnapshotsForTest();
              clearPluginMetadataLifecycleCaches();
              initializeGlobalHookRunner(createEmptyPluginRegistry());
              try {
                operation = parent.track(() =>
                  delegateCompactionToRuntime({
                    sessionId: target.sessionId,
                    sessionKey: target.sessionKey,
                    sessionTarget: target,
                    runtimeContext,
                    abortSignal: controller.signal,
                  }),
                );
                const held = mode !== "success" && mode !== "raw";
                if (held) {
                  await Promise.race([
                    current.entered.promise,
                    operation.then(() => {
                      if (mode !== "cleanup-tail") {
                        throw new Error("Delegate returned before the fixture work started");
                      }
                      return current.entered.promise;
                    }),
                  ]);
                  if (current.session) {
                    await current.session.agent.waitForIdle();
                  }
                  if (
                    mode === "abort-before-commit" ||
                    mode === "abort-after-commit" ||
                    mode === "automatic-after-commit"
                  ) {
                    controller.abort(new Error("fixture caller cancelled compaction"));
                  }
                }
                const result = await operation;
                const cancelled =
                  mode === "abort-before-commit" ||
                  mode === "abort-after-commit" ||
                  mode === "automatic-after-commit" ||
                  mode === "timeout-after-commit";
                expect(result.ok).toBe(!cancelled && mode !== "preparation-failure");
                expect(current.envRestored).toBe(true);
                expect(current.disposals).toBe(mode === "preparation-failure" ? 0 : 1);
                if (current.context) {
                  expect(() => current.context?.isIdle()).toThrow();
                }
                const usageCount = recordUsage.mock.calls.length;
                recordSessionModelUsage(
                  current.session?.sessionManager,
                  assistant(model, summary).usage,
                );
                expect(recordUsage.mock.calls.length).toBe(usageCount);
                const committed = mode !== "abort-before-commit" && mode !== "preparation-failure";
                expect(
                  SessionManager.open(target, state.workspaceDir)
                    .getBranch()
                    .filter((entry) => entry.type === "compaction").length,
                ).toBe(committed ? 1 : 0);
                expect(recordCompaction.mock.calls.length).toBe(committed ? 1 : 0);
                const source = expectDefined(current.source, "selected managed source");
                if (held) {
                  expect(source.database.isOpen).toBe(true);
                  expect(current.tools.length).toBe(mode === "preparation-failure" ? 1 : 2);
                  if (mode !== "cleanup-tail") {
                    expect(current.tools.every((tool) => tool.database.isOpen)).toBe(true);
                  }
                  let finished = false;
                  drained = parent.drain().then(() => {
                    finished = true;
                  });
                  await new Promise<void>((resolve) => {
                    setImmediate(resolve);
                  });
                  expect(finished).toBe(false);
                  current.finish.resolve();
                  await Promise.all(current.pending);
                  await drained;
                  expect(current.lateReads).toBeGreaterThan(0);
                } else {
                  await parent.drain();
                }
                expect(source.disposals).toBe(mode === "raw" ? 0 : 1);
                expect(source.database.isOpen).toBe(mode === "raw");
                for (const tool of current.tools) {
                  expect(tool.disposals).toBe(1);
                  expect(tool.database.isOpen).toBe(false);
                }
                expect(recordCompaction.mock.calls.length).toBe(committed ? 1 : 0);
                if (mode !== "raw") {
                  const reopened = new DatabaseSync(source.file);
                  try {
                    expect(reopened.prepare("SELECT value FROM answer").get()?.value).toBe(42);
                  } finally {
                    reopened.close();
                  }
                }
              } finally {
                current.finish.resolve();
                await Promise.allSettled([operation, ...current.pending]);
                await (drained ?? parent.drain());
                await resetPreparedModelRuntimeSnapshotsForTest();
                current.eventBus.clear();
                vi.restoreAllMocks();
                for (const connection of [...current.registrations, ...current.tools]) {
                  if (connection.database.isOpen) {
                    connection.database.close();
                  }
                }
                delete (globalThis as Record<string, unknown>)[key];
                active.fixture = undefined;
                cleanupPluginLoaderFixturesForTest();
                resetPluginLoaderTestStateForTest();
                clearPluginMetadataLifecycleCaches();
              }
            },
          );
        },
      );
    },
    30_000,
  );
});
