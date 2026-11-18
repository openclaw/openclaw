import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { observeTranscriptHydrations } from "../../../test/helpers/transcript-hydration-observer.js";
import type * as ConfigRuntime from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ContextEngine } from "../../context-engine/types.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { createEnteredGate } from "../entered-gate.test-support.js";
import {
  createAssistant,
  testModel,
} from "../sessions/agent-session-loop-correctness.test-support.js";
import {
  createDelegateCompactionFixture,
  type DelegateFixtureOptions,
} from "./compact.delegate.test-support.js";
import {
  applyExtraParamsToAgentMock,
  buildConfiguredAgentSystemPromptMock,
  buildEmbeddedExtensionFactoriesMock,
  hookRunner,
  limitHistoryTurnsMock,
  loadCompactHooksHarness,
  resetCompactHooksHarnessMocks,
  resolveContextEngineMock,
  resolveModelMock,
  triggerInternalHookMock,
} from "./compact.hooks.harness.js";
import type * as CompactionHooks from "./compaction-hooks.js";
import type { PreparedCompactionSession } from "./run/compaction-accounting-bridge.js";

const { requestPreparedCompaction } = vi.hoisted(() => ({
  requestPreparedCompaction:
    vi.fn<typeof import("@openclaw/ai/transports").requestPreparedOpenAIResponsesCompaction>(),
}));
vi.mock("@openclaw/ai/transports", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/ai/transports")>()),
  requestPreparedOpenAIResponsesCompaction: requestPreparedCompaction,
}));

let delegate: typeof import("../../context-engine/delegate.js").delegateCompactionToRuntime;
let compactQueued: Awaited<
  ReturnType<typeof loadCompactHooksHarness>
>["compactEmbeddedAgentSession"];
let sessions: typeof import("../sessions/index.js");
let accessor: typeof import("../../config/sessions/session-accessor.js");
let databases: typeof import("../../state/openclaw-agent-db.js");
let streamResolution: typeof import("./stream-resolution.js");
let replay: typeof import("../openai-transport-stream.test-support.js").testing;
let accounting: typeof import("./run/compaction-accounting-bridge.js");
let compactionHooks: typeof CompactionHooks;
let configRuntime: typeof ConfigRuntime;
let requestBudgets: typeof import("../sessions/compaction/request-budget.js");
let pressure: typeof import("./run/preemptive-compaction.js");
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await databases.closeOpenClawAgentDatabasesAsync();
    databases.closeOpenClawAgentDatabasesForTest();
    configRuntime.clearRuntimeConfigSnapshot();
    cleanup();
  }),
);
let workspaceDir: string;
const model = {
  ...testModel,
  id: "compaction-fixture",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  contextWindow: 128_000,
  maxTokens: 1_024,
};
const summary = "The deployment checklist was reviewed. Compare the remaining options.";

beforeAll(async () => {
  // Reuse the hook harness's provider setup with the real constructor, SQLite
  // manager, transcript guard, and both compaction owners left intact.
  ({ compactEmbeddedAgentSession: compactQueued } = await loadCompactHooksHarness({
    durableSession: true,
  }));
  [
    { delegateCompactionToRuntime: delegate },
    sessions,
    accessor,
    databases,
    streamResolution,
    { testing: replay },
    accounting,
    compactionHooks,
    configRuntime,
    requestBudgets,
    pressure,
  ] = await Promise.all([
    import("../../context-engine/delegate.js"),
    import("../sessions/index.js"),
    import("../../config/sessions/session-accessor.js"),
    import("../../state/openclaw-agent-db.js"),
    import("./stream-resolution.js"),
    import("../openai-transport-stream.test-support.js"),
    import("./run/compaction-accounting-bridge.js"),
    import("./compaction-hooks.js"),
    import("../../config/runtime-snapshot.js"),
    import("../sessions/compaction/request-budget.js"),
    import("./run/preemptive-compaction.js"),
  ]);
});

beforeEach(async () => {
  workspaceDir = tempDirs.make("openclaw-compaction-delegate-");
  resetCompactHooksHarnessMocks(workspaceDir);
  const actualScope =
    await vi.importActual<typeof import("../agent-scope.js")>("../agent-scope.js");
  const scope = await import("../agent-scope.js");
  vi.mocked(scope.listAgentEntries).mockImplementation(actualScope.listAgentEntries);
  vi.mocked(scope.listAgentEntriesWithSource).mockImplementation(
    actualScope.listAgentEntriesWithSource,
  );
  vi.mocked(scope.resolveSessionAgentId).mockImplementation(actualScope.resolveSessionAgentId);
  vi.mocked(scope.resolveSessionAgentIds).mockImplementation(actualScope.resolveSessionAgentIds);
  requestPreparedCompaction.mockReset();
  limitHistoryTurnsMock.mockImplementation((messages) => messages);
  hookRunner.hasHooks.mockImplementation(
    (name) => name === "before_compaction" || name === "after_compaction",
  );
});

function createFixture(
  operation: "summary" | "endpoint",
  globalAlias = false,
  options: DelegateFixtureOptions = {},
) {
  return createDelegateCompactionFixture(
    {
      workspaceDir,
      sessions,
      accessor,
      model,
      summary,
      resolveModelMock,
      streamResolution,
      applyExtraParamsToAgentMock,
      requestPreparedCompaction,
      replay,
      configRuntime,
      accounting,
    },
    operation,
    globalAlias,
    options,
  );
}

describe("direct compactor through the context-engine delegate", () => {
  it.each(["plain", "custom", "metadata"] as const)(
    "keeps full-history preparation in the native reader for default safeguard maintenance (shape=%s)",
    async (shape) => {
      const fixture = await createFixture("summary", false, {
        liveOutputChars: 100_000,
        projectedCustomHistory: shape === "custom",
        retainedCacheMetadata: shape === "metadata",
      });
      const actualExtensions =
        await vi.importActual<typeof import("./extensions.js")>("./extensions.js");
      buildEmbeddedExtensionFactoriesMock.mockImplementationOnce(
        actualExtensions.buildEmbeddedExtensionFactories,
      );
      const inputConfig: OpenClawConfig = {
        ...fixture.runtimeContext.config,
        agents: {
          ...fixture.runtimeContext.config.agents,
          defaults: {
            ...fixture.runtimeContext.config.agents.defaults,
            models: {
              [model.provider + "/" + model.id]: { params: { responsesCompactEndpoint: false } },
            },
            compaction: {
              keepRecentTokens: 1,
              recentTurnsPreserve: 0,
              postIndexSync: "off",
              qualityGuard: { enabled: false },
            },
          },
        },
      };
      // Exercise new-config defaults, not the SDK opt-out selected by an unnormalized config.
      const { applyCompactionDefaults } = await import("../../config/defaults.js");
      const config = applyCompactionDefaults(inputConfig);
      expect(inputConfig.agents?.defaults?.compaction?.mode).toBeUndefined();
      expect(config.agents?.defaults?.compaction?.mode).toBe("safeguard");
      configRuntime.setRuntimeConfigSnapshot(config);
      const manager = await sessions.SessionManager.openAsync(fixture.target, workspaceDir);
      await manager.appendCustomEntryAsync("model-snapshot", {
        timestamp: 1,
        provider: model.provider,
        modelApi: model.api,
        modelId: model.id,
      });
      const runtimeContext = { ...fixture.runtimeContext, trigger: "budget" as const, config };
      accounting.attachCompactionAccountingRecorder(runtimeContext, {
        recordUsage: fixture.recordUsage,
        recordCompaction: fixture.recordCompaction,
      });
      const { historyLane, sessionStoreLane } =
        await import("../../config/sessions/session-transcript-worker-resources.js");
      let hydratedBytes = 0;
      const spies = [historyLane, sessionStoreLane].map(({ pool }) => {
        const run = pool.run.bind(pool);
        return vi.spyOn(pool, "run").mockImplementation((input, options) => {
          let compactionRead = false;
          const receive = options.onRequest;
          return run(
            async () => {
              const request = typeof input === "function" ? await input() : input;
              compactionRead =
                request.kind === "transcript-hydration" &&
                Boolean(request.limits && "compaction" in request.limits);
              return request;
            },
            {
              ...options,
              ...(receive
                ? {
                    onRequest: async (value, context) => {
                      if (compactionRead && fixture.stream.mock.calls.length === 0) {
                        // The paired reader owns this chunk envelope; count bytes, never content.
                        const chunk =
                          value as import("../../config/sessions/session-transcript-hydration.types.js").SessionTranscriptHydrationChunk;
                        if (chunk.kind === "transcript-hydration-chunk") {
                          hydratedBytes += chunk.frames.reduce(
                            (total, frame) => total + frame.data.byteLength,
                            0,
                          );
                        }
                      }
                      return await receive(value, context);
                    },
                  }
                : {}),
            },
          );
        });
      });
      try {
        const result = await delegate({
          ...fixture.delegateParams,
          runtimeContext,
          force: true,
          currentTokenCount: model.contextWindow * 2,
        });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, compacted: true });
        // The complete >300k summarized window must not be prepared on the host.
        // A retained metadata tail and postcommit reload retain their own channel.
        expect(hydratedBytes).toBeLessThan(192 * 1024);
        expect(fixture.stream).toHaveBeenCalled();
        if (shape === "custom") {
          expect(JSON.stringify(fixture.stream.mock.calls[0]?.[1])).toContain(
            "A visible contextual finding:",
          );
        }
        expect(fixture.recordUsage.mock.calls.length).toBe(fixture.stream.mock.calls.length);
        expect(requestPreparedCompaction).not.toHaveBeenCalled();
        expect(hookRunner.runBeforeCompaction).toHaveBeenCalledOnce();
        expect(hookRunner.runAfterCompaction).toHaveBeenCalledOnce();
      } finally {
        spies.forEach((spy) => spy.mockRestore());
      }
      await databases.closeOpenClawAgentDatabasesAsync();
      const restored = await sessions.SessionManager.openAsync(fixture.target, workspaceDir);
      expect(restored.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
      for (const entry of fixture.originalEntries) {
        expect(restored.getEntries()).toContainEqual(entry);
      }
      if (shape === "metadata") {
        const { readCacheTtlCheckpoint } = await import("./cache-ttl-checkpoint.js");
        const expected = readCacheTtlCheckpoint(fixture.originalEntries);
        expect(JSON.stringify(expected).length).toBeGreaterThan(160_000);
        expect(readCacheTtlCheckpoint(restored.getToolResultProjectionEntries())).toEqual(expected);
      }
    },
  );

  it.each([
    ...(
      [
        { limit: "at-boundary", enabled: true, explicit: undefined, expected: "transcript_bytes" },
        { limit: "above-boundary", enabled: true, explicit: undefined, expected: undefined },
        { limit: "zero", enabled: true, explicit: undefined, expected: undefined },
        { limit: "at-boundary", enabled: false, explicit: undefined, expected: undefined },
        { limit: "at-boundary", enabled: true, explicit: "tokens", expected: "tokens" },
        {
          limit: "at-boundary",
          enabled: true,
          explicit: "transcript_bytes",
          expected: "transcript_bytes",
        },
        { limit: "no-config", enabled: true, explicit: undefined, expected: undefined },
        { limit: "no-limit", enabled: true, explicit: undefined, expected: undefined },
        { limit: "invalid", enabled: true, explicit: undefined, expected: undefined },
      ] as const
    ).map((row) => Object.assign(row, { trigger: "manual" as const })),
    {
      limit: "at-boundary",
      enabled: true,
      explicit: "tokens",
      expected: "tokens",
      trigger: "budget",
    },
  ] as const)(
    "passes honest queued byte pressure (trigger=$trigger, limit=$limit, enabled=$enabled, explicit=$explicit)",
    async ({ trigger, limit, enabled, explicit, expected }) => {
      const fixture = await createFixture("summary");
      const { readSessionTranscriptAccountingAsync } =
        await import("../../gateway/session-transcript-readers.js");
      const snapshot = await readSessionTranscriptAccountingAsync(fixture.target, {
        includeByteSize: true,
        includeUsage: false,
      });
      expect(snapshot.byteSize).toBeGreaterThan(0);
      if (snapshot.byteSize === undefined) {
        throw new Error("Fixture must have measured active transcript bytes");
      }
      const maxActiveTranscriptBytes =
        limit === "zero"
          ? 0
          : limit === "no-limit"
            ? undefined
            : limit === "invalid"
              ? "invalid"
              : `${snapshot.byteSize + (limit === "above-boundary" ? 1 : 0)}b`;
      const backend = vi.fn<ContextEngine["compact"]>(async () => ({
        ok: true,
        compacted: false,
      }));
      resolveContextEngineMock.mockResolvedValueOnce({
        info: { ownsCompaction: true },
        compact: backend,
      });
      const result = await compactQueued({
        ...fixture.queuedParams,
        config:
          limit === "no-config"
            ? undefined
            : {
                ...fixture.runtimeContext.config,
                agents: {
                  ...fixture.runtimeContext.config.agents,
                  defaults: { compaction: { enabled, maxActiveTranscriptBytes } },
                },
              },
        trigger,
        preflightCompactionTrigger: explicit,
      });
      expect(result).toMatchObject({ ok: true, compacted: false });
      expect(backend).toHaveBeenCalledOnce();
      expect(backend.mock.calls[0]?.[0].runtimeContext).toMatchObject({
        trigger,
        preflightCompactionTrigger: expected,
      });
      expect(sessions.SessionManager.open(fixture.target).getEntries()).toEqual(
        fixture.originalEntries,
      );
    },
  );

  it.each([
    { operation: "summary", ownsCompaction: false, prepared: false },
    { operation: "endpoint", ownsCompaction: false, prepared: false },
    { operation: "summary", ownsCompaction: true, prepared: false },
    { operation: "endpoint", ownsCompaction: true, prepared: false },
    { operation: "summary", ownsCompaction: false, prepared: true },
  ] as const)(
    "runs one queued delegated $operation lifecycle (ownsCompaction=$ownsCompaction, prepared=$prepared)",
    async ({ operation, ownsCompaction, prepared }) => {
      const fixture = await createFixture(operation);
      const backend = vi.fn<ContextEngine["compact"]>(delegate);
      const info = {
        id: prepared ? "legacy" : "fixture",
        name: "Compaction fixture",
        ownsCompaction,
      } satisfies ContextEngine["info"];
      resolveContextEngineMock.mockResolvedValueOnce({
        info,
        compact: backend,
      });
      const { readPreparedSessionCompactionInWorker } =
        await import("../../config/sessions/session-compaction-prepared.js");
      const { persistCompactionBoundaryWithSessionEntryAsync } =
        await import("../../config/sessions/session-accessor.sqlite-compaction-runtime.js");
      const preflight = prepared
        ? await readPreparedSessionCompactionInWorker(fixture.target, { kind: "preflight" })
        : undefined;
      const preparation = preflight?.status === "preflight" ? preflight : undefined;
      const persistBoundary = vi.fn(
        async (
          append: import("../sessions/session-compaction-persistence.js").PreparedCompactionAppend,
        ) =>
          persistCompactionBoundaryWithSessionEntryAsync(append.scope, {
            prepared: append,
            tokensAfter: append.event.tokensAfter,
            transcriptByteCompactionLatch: null,
          }),
      );
      const effects = vi.spyOn(compactionHooks, "runPostCompactionSideEffects");
      try {
        const result = await compactQueued(
          fixture.queuedParams,
          preparation?.runtimeEntry
            ? {
                preparedSession: { ...preparation, entry: preparation.runtimeEntry },
                withCompactionPersistenceAsync: persistBoundary,
              }
            : undefined,
        );
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, compacted: true });
        expect(backend).toHaveBeenCalledOnce();
        expect.soft(hookRunner.runBeforeCompaction).toHaveBeenCalledOnce();
        expect.soft(hookRunner.runAfterCompaction).toHaveBeenCalledOnce();
        expect.soft(effects).toHaveBeenCalledOnce();
        // Native session events still carry real transcript metrics even when
        // the queued host owns plugin callbacks and post-compaction refresh.
        expect(triggerInternalHookMock.mock.calls.map(([event]) => event)).toEqual([
          expect.objectContaining({ action: "compact:before" }),
          expect.objectContaining({ action: "compact:after" }),
        ]);
        if (prepared) {
          expect(persistBoundary).toHaveBeenCalledOnce();
          const { readSessionEntryReadOnlyInWorker } =
            await import("../../config/sessions/session-entry-read-runtime.js");
          expect(await readSessionEntryReadOnlyInWorker(fixture.target)).toMatchObject({
            compactionCount: 1,
          });
        }
        const manager = sessions.SessionManager.open(fixture.target);
        if (operation === "summary") {
          expect(manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(
            1,
          );
          for (const entry of fixture.originalEntries) {
            expect(manager.getEntries()).toContainEqual(entry);
          }
        } else {
          expect(manager.buildSessionContext().messages.at(-1)).toMatchObject({
            providerReplay: { data: "opaque-fixture", compactedWindow: { state: "ready" } },
          });
        }
        expect(sessions.SessionManager.open(fixture.decoy).buildSessionContext().messages).toEqual([
          { role: "user", content: "Unrelated store history", timestamp: 1 },
        ]);
      } finally {
        effects.mockRestore();
      }
    },
  );

  it.each([
    { budget: "absent", pendingPrompt: "" },
    { budget: "foreground with pending input", pendingPrompt: "Unrecorded request. ".repeat(500) },
  ])(
    "records server checkpoint pressure with $budget budget",
    async ({ budget, pendingPrompt }) => {
      const fixture = await createFixture("endpoint");
      const compactorPrompt = "Summarize the deployment discussion.";
      buildConfiguredAgentSystemPromptMock.mockResolvedValue(compactorPrompt);
      const requestBudget = requestBudgets.createCompactionRequestBudget({
        contextWindow: model.contextWindow,
        reserveTokens: 16_384,
        systemPrompt: "Help the operator deploy safely using the available tools.",
        tools: [
          {
            name: "lookup_deployment",
            description: "Available deployment target and its constraints. ".repeat(500),
            parameters: { type: "object", properties: { target: { type: "string" } } },
          },
        ],
        pendingPrompt,
      });
      const hasBudget = budget !== "absent";
      accounting.attachCompactionAccountingRecorder(fixture.runtimeContext, {
        ...(hasBudget ? { requestBudget } : {}),
        recordUsage: fixture.recordUsage,
        recordCompaction: fixture.recordCompaction,
      });
      const manager = sessions.SessionManager.open(fixture.target, workspaceDir);
      const retainedUsers = manager
        .buildSessionContext()
        .messages.filter((message) => message.role === "user")
        .map((message) => {
          if (typeof message.content !== "string") {
            throw new Error("Expected plain-text fixture input");
          }
          return {
            type: "message" as const,
            role: "user" as const,
            content: [{ type: "input_text" as const, text: message.content }],
          };
        });
      const checkpoint = {
        type: "compaction" as const,
        id: "cmp_budget",
        encrypted_content: "opaque",
      };
      const output = [...retainedUsers, checkpoint];
      requestPreparedCompaction.mockImplementationOnce(
        async (_stream, requestModel, _context, options) => ({
          item: checkpoint,
          output,
          historyMode: "retained-users",
          usage: { input_tokens: 30_000, output_tokens: 200 },
          model: requestModel,
          replayMetadata: replay.buildOpenAIResponsesReasoningReplayMetadata(requestModel, options),
        }),
      );

      const result = await delegate(fixture.delegateParams);
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, compacted: true });
      expect(result.result?.details).toMatchObject({ compactionKind: "server-endpoint" });
      await databases.closeOpenClawAgentDatabasesAsync();
      databases.closeOpenClawAgentDatabasesForTest();
      const messages = sessions.SessionManager.open(fixture.target).buildSessionContext().messages;
      const endpointCall = requestPreparedCompaction.mock.calls[0]!;
      const replayContext = {
        model: endpointCall[1],
        sessionId: endpointCall[3].sessionId,
        authProfileId: endpointCall[3].authProfileId,
        enabled: true,
      };
      const replayHistory =
        pressure.estimateLlmBoundaryTokenPressure({ messages, prompt: "", replay: replayContext }) -
        pressure.estimateRenderedLlmBoundaryTokenPressure({ prompt: "" });
      const expected = hasBudget
        ? requestBudget.fixedTokens + replayHistory
        : pressure.estimateLlmBoundaryTokenPressure({
            messages,
            systemPrompt: compactorPrompt,
            prompt: "",
            replay: replayContext,
          });
      expect(requestBudget.fixedTokens).toBeGreaterThan(5_000);
      expect(result.result?.tokensAfter).toBe(expected);
      expect(fixture.recordCompaction).toHaveBeenCalledExactlyOnceWith({
        tokensBefore: 30_000,
        tokensAfter: expected,
        compactionKind: "server-endpoint",
      });
      expect(requestPreparedCompaction).toHaveBeenCalledOnce();
      expect(fixture.stream).not.toHaveBeenCalled();
    },
  );

  it.each([
    { operation: "summary", partial: true, threadId: 0 },
    { operation: "endpoint", partial: false, threadId: 0 },
  ] as const)(
    "returns durable $operation identity (partial=$partial, thread=$threadId)",
    async ({ operation, partial, threadId }) => {
      const fixture = await createFixture(operation, partial);
      const { target } = fixture;
      const sessionTarget = {
        ...(partial ? { agentId: target.agentId, storePath: target.storePath } : target),
        ...(threadId !== undefined ? { threadId } : {}),
        expectedWriterRunId: "caller-private-writer",
        expectedLifecycleRevision: "caller-private-revision",
        unrelatedCapability: "caller-private-capability",
      };
      const sql = observeHostDataSql();
      hookRunner.runBeforeCompaction.mockImplementationOnce(async () => {
        sql.restore();
        return undefined;
      });
      const result = await delegate({
        ...fixture.delegateParams,
        sessionTarget,
      }).finally(sql.restore);
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, compacted: true });
      expect(
        sql.queries.filter(
          (query) => /\bselect\b/i.test(query) && /\btranscript_events\b/i.test(query),
        ),
      ).toEqual([]);
      const returned = result.result?.sessionTarget;
      expect(returned).toEqual({ ...target, ...(threadId !== undefined ? { threadId } : {}) });
      expect(result.result).not.toHaveProperty("sessionFile");
      if (
        !returned?.agentId ||
        !returned.sessionId ||
        !returned.sessionKey ||
        !returned.storePath
      ) {
        throw new Error("Compactor must return its complete resolved identity");
      }
      // Close the actual DB handles before observing the returned identity and history.
      await databases.closeOpenClawAgentDatabasesAsync();
      databases.closeOpenClawAgentDatabasesForTest();
      const reopened = sessions.SessionManager.open({
        agentId: returned.agentId,
        sessionId: returned.sessionId,
        sessionKey: returned.sessionKey,
        storePath: returned.storePath,
      });
      expect(reopened.getSessionId()).toBe(target.sessionId);
      expect(accessor.loadSessionEntry(target)?.sessionId).toBe(target.sessionId);
      const messages = reopened.buildSessionContext().messages;
      if (operation === "summary") {
        expect(result.result?.summary).toContain(summary);
        expect(reopened.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
        const firstKeptIndex = fixture.originalEntries.findIndex(
          (entry) => entry.id === result.result?.firstKeptEntryId,
        );
        expect(firstKeptIndex).toBeGreaterThan(0);
        const retained = fixture.originalEntries
          .slice(firstKeptIndex)
          .filter((entry) => entry.type === "message")
          .map((entry) => entry.message);
        expect(retained.length).toBeGreaterThan(0);
        expect(messages.slice(-retained.length)).toEqual(retained);
        for (const entry of fixture.originalEntries) {
          expect(reopened.getEntries()).toContainEqual(entry);
        }
        expect(fixture.stream).toHaveBeenCalled();
        expect(requestPreparedCompaction).not.toHaveBeenCalled();
      } else {
        expect(result.result?.summary).toBeUndefined();
        expect(result.result?.details).toMatchObject({ compactionKind: "server-endpoint" });
        expect(messages).toMatchObject(fixture.originalMessages);
        expect(messages.at(-1)).toMatchObject({
          providerReplay: { data: "opaque-fixture", compactedWindow: { state: "ready" } },
        });
        expect(requestPreparedCompaction).toHaveBeenCalledOnce();
        expect(fixture.stream).not.toHaveBeenCalled();
      }
      expect(fixture.recordUsage).toHaveBeenCalled();
      expect(fixture.recordCompaction).toHaveBeenCalledOnce();
      expect(hookRunner.runBeforeCompaction).toHaveBeenCalledOnce();
      expect(hookRunner.runAfterCompaction).toHaveBeenCalledOnce();
      expect(sessions.SessionManager.open(fixture.decoy).buildSessionContext().messages).toEqual([
        { role: "user", content: "Unrelated store history", timestamp: 1 },
      ]);
      expect(accessor.loadSessionEntry(target)).not.toHaveProperty("compactionCheckpoints");
      expect(accessor.loadSessionEntry(fixture.decoy)).not.toHaveProperty("compactionCheckpoints");
    },
  );

  it.each(["summary", "endpoint"] as const)(
    "cancels %s without publishing or rewriting history",
    async (operation) => {
      const fixture = await createFixture(operation);
      const started = createDeferred();
      const stopped = createDeferred();
      const controller = new AbortController();
      const abortReason = new Error("caller cancelled compaction");
      if (operation === "endpoint") {
        requestPreparedCompaction.mockImplementationOnce(
          async (_stream, _model, _context, options) => {
            started.resolve();
            return await new Promise<never>((_, reject) => {
              options.signal?.addEventListener(
                "abort",
                () => {
                  stopped.resolve();
                  reject(abortReason);
                },
                { once: true },
              );
            });
          },
        );
      } else {
        const { createAssistantMessageEventStream } = await import("openclaw/plugin-sdk/llm");
        fixture.stream.mockImplementationOnce((activeModel, _context, options) => {
          const stream = createAssistantMessageEventStream();
          started.resolve();
          options?.signal?.addEventListener(
            "abort",
            () => {
              stream.push({
                type: "error",
                reason: "aborted",
                error: createAssistant(activeModel, [], "aborted"),
              });
              stream.end();
              stopped.resolve();
            },
            { once: true },
          );
          return stream;
        });
      }
      const pending = delegate({
        ...fixture.delegateParams,
        sessionTarget: { ...fixture.target, threadId: 0 },
        abortSignal: controller.signal,
      });
      await started.promise;
      controller.abort(abortReason);
      const result = await pending;
      await stopped.promise;
      expect(result).toMatchObject({ ok: false, compacted: false });
      expect(result.result).toBeUndefined();
      await databases.closeOpenClawAgentDatabasesAsync();
      databases.closeOpenClawAgentDatabasesForTest();
      const reopened = sessions.SessionManager.open(fixture.target);
      expect(reopened.getSessionId()).toBe(fixture.target.sessionId);
      const entries = reopened.getEntries();
      expect(entries.slice(0, fixture.originalEntries.length)).toEqual(fixture.originalEntries);
      // Replay metadata commits before inference; abort must not publish a summary boundary.
      expect(entries.slice(fixture.originalEntries.length)).toEqual(
        operation === "summary"
          ? [expect.objectContaining({ type: "custom", customType: "model-snapshot" })]
          : [],
      );
      expect(reopened.buildSessionContext().messages).toEqual(fixture.originalMessages);
      expect(fixture.recordCompaction).not.toHaveBeenCalled();
      expect(hookRunner.runAfterCompaction).not.toHaveBeenCalled();
    },
  );

  it.each(["abort", "owner-replaced"] as const)(
    "discards a hydrated compaction transcript after %s before publication",
    async (transition) => {
      const fixture = await createFixture("summary");
      const { historyLane } =
        await import("../../config/sessions/session-transcript-worker-resources.js");
      const { withSessionTranscriptWriteAssertion } =
        await import("../../config/sessions/transcript-write-context.js");
      const hydrationGate = createEnteredGate();
      const controller = new AbortController();
      let current = true;
      const reason = new Error("compaction preparation no longer current");
      const run = historyLane.pool.run.bind(historyLane.pool);
      const read = vi.spyOn(historyLane.pool, "run").mockImplementation((input, options) => {
        let hydration = false;
        return run(async () => {
          const request = typeof input === "function" ? await input() : input;
          hydration = request.kind === "compaction-preparation";
          return request;
        }, options).then(async (snapshot) => {
          if (hydration) {
            read.mockRestore();
            await hydrationGate.wait();
          }
          return snapshot;
        });
      });
      const pending = withSessionTranscriptWriteAssertion(
        fixture.target,
        () => {
          if (!current) {
            throw reason;
          }
        },
        () =>
          delegate({
            ...fixture.delegateParams,
            abortSignal: controller.signal,
          }),
      );
      try {
        await awaitGateBeforeSettlement(
          hydrationGate.entered,
          pending,
          "Compaction completed before the native hydration reply",
        );
        if (transition === "abort") {
          controller.abort(reason);
        } else {
          current = false;
        }
        hydrationGate.release();
        expect(await pending).toMatchObject({ ok: false, compacted: false });
        expect(fixture.stream).not.toHaveBeenCalled();
        expect(hookRunner.runBeforeCompaction).not.toHaveBeenCalled();
        expect(hookRunner.runAfterCompaction).not.toHaveBeenCalled();
        expect(fixture.recordCompaction).not.toHaveBeenCalled();
        await databases.closeOpenClawAgentDatabasesAsync();
        databases.closeOpenClawAgentDatabasesForTest();
        expect(sessions.SessionManager.open(fixture.target).getEntries()).toEqual(
          fixture.originalEntries,
        );
      } finally {
        hydrationGate.release();
        read.mockRestore();
        await pending.catch(() => undefined);
      }
    },
  );

  it.each(["manual", "budget"] as const)(
    "compacts complete current context through %s without hydrating obsolete history",
    async (trigger) => {
      const marker = "Earlier work: the first rollout plan was approved and shipped.";
      // The prior summary alone exceeds a 32k foreground model's 256 KB replay
      // cap, but fits this fixture's 128k summarizer. Keep it and every live turn.
      const previousSummary = `${marker} ${"Detail. ".repeat(40_000)}`;
      const fixture = await createFixture("summary", false, {
        archivedTurns: 40,
        previousSummary,
        liveOutputChars: 500_000,
      });
      await accessor.upsertSessionEntryCore(fixture.target, { contextTokens: 32_000 });
      resolveContextEngineMock.mockResolvedValueOnce({
        info: { ownsCompaction: false },
        compact: vi.fn<ContextEngine["compact"]>(delegate),
      });
      const observed = await observeTranscriptHydrations();
      try {
        let preparedSession: PreparedCompactionSession | undefined;
        if (trigger === "manual") {
          const { prepareGatewaySessionCompaction } =
            await import("../../gateway/server-methods/sessions-compaction-runner.js");
          const entry = accessor.loadSessionEntry(fixture.target);
          if (!entry) {
            throw new Error("expected the compaction fixture session");
          }
          const prepared = await prepareGatewaySessionCompaction({
            agentId: fixture.target.agentId,
            cfg: fixture.runtimeContext.config,
            entry,
            sessionId: fixture.target.sessionId,
            sessionKey: fixture.target.sessionKey,
            sessionStoreKey: fixture.target.sessionKey,
            storePath: fixture.target.storePath,
          });
          preparedSession = prepared.preparedSession;
          expect(preparedSession?.sessionTarget).toEqual(fixture.target);
          expect(preparedSession).not.toHaveProperty("sessionManager");
        }
        const result = await compactQueued(
          { ...fixture.queuedParams, trigger, contextTokenBudget: 32_000 },
          preparedSession ? { preparedSession } : undefined,
        );
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, compacted: true });
      } finally {
        observed.restore();
      }
      expect(observed.hydrations).toEqual([]);
      const requests = fixture.stream.mock.calls.map((call) => JSON.stringify(call[1]));
      expect(requests.some((request) => request.includes(marker))).toBe(true);
      expect(requests.join("\n")).not.toContain("Archived request");
      const manager = sessions.SessionManager.open(fixture.target);
      expect(manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(2);
      for (const entry of fixture.originalEntries) {
        expect(manager.getEntries()).toContainEqual(entry);
      }
    },
  );

  it("rejects contradictory physical identity without touching either durable transcript", async () => {
    const fixture = await createFixture("summary");
    await expect(
      delegate({
        sessionId: "contradictory-session",
        sessionKey: fixture.target.sessionKey,
        sessionTarget: fixture.target,
        runtimeContext: fixture.runtimeContext,
      }),
    ).rejects.toThrow("conflicts with the caller session identity");
    expect(fixture.stream).not.toHaveBeenCalled();
    expect(resolveModelMock).not.toHaveBeenCalled();
    expect(hookRunner.runBeforeCompaction).not.toHaveBeenCalled();
    await databases.closeOpenClawAgentDatabasesAsync();
    databases.closeOpenClawAgentDatabasesForTest();
    expect(sessions.SessionManager.open(fixture.target).getEntries()).toEqual(
      fixture.originalEntries,
    );
    expect(sessions.SessionManager.open(fixture.decoy).buildSessionContext().messages).toEqual([
      { role: "user", content: "Unrelated store history", timestamp: 1 },
    ]);
  });

  it.each([
    { operation: "summary", ownsCompaction: false },
    { operation: "endpoint", ownsCompaction: false },
    { operation: "summary", ownsCompaction: true },
    { operation: "endpoint", ownsCompaction: true },
  ] as const)(
    "keeps queued manual $operation compaction countable when cancellation follows its commit during a post-compaction hook (ownsCompaction=$ownsCompaction)",
    async ({ operation, ownsCompaction }) => {
      const fixture = await createFixture(operation);
      const { incrementCompactionCount } =
        await import("../../auto-reply/reply/session-updates.js");
      const backend = vi.fn<ContextEngine["compact"]>(delegate);
      resolveContextEngineMock.mockResolvedValueOnce({
        info: { ownsCompaction },
        compact: backend,
      });
      const expectedSession = accessor.loadSessionEntry(fixture.target);
      if (!expectedSession) {
        throw new Error("expected the queued compaction's persisted session");
      }
      const hookGate = createEnteredGate();
      const expectCommittedTranscript = () => {
        const manager = sessions.SessionManager.open(fixture.target);
        if (operation === "summary") {
          const compactions = manager.getBranch().filter((entry) => entry.type === "compaction");
          expect(compactions).toHaveLength(1);
          const committed = compactions[0];
          if (!committed) {
            throw new Error("expected the persisted summary compaction");
          }
          expect(committed.summary).toContain(summary);
          expect(committed.tokensBefore).toBeGreaterThan(0);
          return committed.tokensBefore;
        }
        expect(manager.buildSessionContext().messages.at(-1)).toMatchObject({
          providerReplay: { data: "opaque-fixture", compactedWindow: { state: "ready" } },
        });
        return 1_000;
      };
      hookRunner.runAfterCompaction.mockImplementationOnce(async () => {
        expectCommittedTranscript();
        await hookGate.wait();
      });
      const controller = new AbortController();
      const work = new AsyncWorkScope();
      const pending = work.run(() =>
        compactQueued({
          ...fixture.queuedParams,
          abortSignal: controller.signal,
        }),
      );
      try {
        await Promise.race([
          hookGate.entered,
          pending.then((result) => {
            throw new Error(
              `Queued compaction returned before its post-commit hook: ${JSON.stringify(result)}`,
            );
          }),
        ]);
        controller.abort(new Error("caller stopped after compaction committed"));
        // Host-owned hooks are awaited rather than cancelled. Finish the hook
        // after abort so the committed result can settle through either owner.
        hookGate.release();
        const result = await pending;
        expect.soft(result).toMatchObject({
          ok: true,
          compacted: true,
          compactionKind: operation === "summary" ? "context-engine" : "server-endpoint",
        });
        const count =
          result.ok && result.compacted
            ? await incrementCompactionCount({
                agentId: fixture.target.agentId,
                sessionEntry: expectedSession,
                sessionStore: { [fixture.target.sessionKey]: expectedSession },
                sessionKey: fixture.target.sessionKey,
                storePath: fixture.target.storePath,
                expectedSession,
                tokensAfter: result.result?.tokensAfter,
                compactionKind: result.compactionKind,
              })
            : undefined;
        expect.soft(count).toBe(1);
        expect.soft(accessor.loadSessionEntry(fixture.target)?.compactionCount).toBe(1);
        expect(backend).toHaveBeenCalledOnce();
        expect(result.result?.tokensBefore).toBe(expectCommittedTranscript());
        expect(sessions.SessionManager.open(fixture.decoy).buildSessionContext().messages).toEqual([
          { role: "user", content: "Unrelated store history", timestamp: 1 },
        ]);
      } finally {
        hookGate.release();
        await pending.catch(() => undefined);
        await work.drain();
      }
    },
  );
});

it("rebases prepared compaction metadata over an accepted descendant append", async () => {
  const fixture = await createFixture("summary");
  const persistence = await import("../sessions/session-compaction-persistence.js");
  const append = persistence.appendSessionMetadataInWorker;
  let descendant: string | undefined;
  const metadata = vi
    .spyOn(persistence, "appendSessionMetadataInWorker")
    .mockImplementation(async (prepared, assertCurrent) => {
      if (!descendant && prepared.event.type === "custom") {
        const manager = await sessions.SessionManager.openAsync(fixture.target, workspaceDir);
        descendant = await manager.appendMessageAsync({
          role: "user",
          content: "Accepted while preparing metadata",
          timestamp: 100,
        });
      }
      return append(prepared, assertCurrent);
    });
  try {
    const result = await delegate(fixture.delegateParams);
    expect(result).toMatchObject({ ok: true, compacted: true });
    expect(descendant).toBeDefined();
    const manager = await sessions.SessionManager.openAsync(fixture.target, workspaceDir);
    const branch = manager.getBranch();
    expect(branch.map((entry) => entry.id)).toContain(descendant);
    const marker = branch.find(
      (entry) => entry.type === "custom" && entry.customType === "model-snapshot",
    );
    expect(marker?.parentId).toBe(descendant);
    expect(manager.buildSessionContext().messages).toContainEqual(
      expect.objectContaining({ role: "user", content: "Accepted while preparing metadata" }),
    );
    const { sanitizeCompactionReplayMessages } = await import("../compaction-replay.js");
    const context = sanitizeCompactionReplayMessages(manager.buildSessionContext().messages);
    const { estimateContextTokens } =
      await import("../../../packages/agent-core/src/harness/compaction/compaction.js");
    expect(result.result?.tokensAfter).toBe(estimateContextTokens(context).tokens);
    expect(fixture.recordCompaction).toHaveBeenCalledWith(
      expect.objectContaining({
        tokensAfter: estimateContextTokens(context).tokens,
      }),
    );
  } finally {
    metadata.mockRestore();
  }
});
