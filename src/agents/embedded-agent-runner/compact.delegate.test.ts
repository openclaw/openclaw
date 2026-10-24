import { join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { observeTranscriptHydrations } from "../../../test/helpers/transcript-hydration-observer.js";
import type * as ConfigRuntime from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ContextEngine, ContextEngineRuntimeContext } from "../../context-engine/types.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import {
  createAssistant,
  createAssistantResultStream,
  testModel,
} from "../sessions/agent-session-loop-correctness.test-support.js";
import type { ProviderConfigInput } from "../sessions/model-registry.js";
import {
  applyExtraParamsToAgentMock,
  buildConfiguredAgentSystemPromptMock,
  hookRunner,
  limitHistoryTurnsMock,
  loadCompactHooksHarness,
  resetCompactHooksHarnessMocks,
  resolveContextEngineMock,
  resolveModelMock,
} from "./compact.hooks.harness.js";

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
let configRuntime: typeof ConfigRuntime;
let pressure: typeof import("./run/preemptive-compaction.js");
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeDatabases();
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
const userTurns = [
  "Review the deployment checklist.",
  "Compare the remaining options.",
  "Keep the rollout notes.",
];
const decoyMessages = [{ role: "user", content: "Unrelated store history", timestamp: 1 }];
const endpointReplay = {
  providerReplay: { data: "opaque-fixture", compactedWindow: { state: "ready" } },
};

async function closeDatabases() {
  await databases.closeOpenClawAgentDatabasesAsync();
  databases.closeOpenClawAgentDatabasesForTest();
}

function expectUncalled(...mocks: unknown[]) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}

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
    configRuntime,
    pressure,
  ] = await Promise.all([
    import("../../context-engine/delegate.js"),
    import("../sessions/index.js"),
    import("../../config/sessions/session-accessor.js"),
    import("../../state/openclaw-agent-db.js"),
    import("./stream-resolution.js"),
    import("../openai-transport-stream.test-support.js"),
    import("./run/compaction-accounting-bridge.js"),
    import("../../config/runtime-snapshot.js"),
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

async function createFixture(
  operation: "summary" | "endpoint",
  globalAlias = false,
  options: { archivedTurns?: number; previousSummary?: string; liveOutputChars?: number } = {},
) {
  const target = {
    agentId: globalAlias ? "marketing" : "main",
    sessionId: "compaction-session",
    sessionKey: globalAlias ? "global" : "agent:main:compaction-session",
    storePath: join(workspaceDir, "alternate", "openclaw-agent.sqlite"),
  };
  const configuredStore = join(workspaceDir, "configured", "openclaw-agent.sqlite");
  await accessor.upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
  // The same physical id in another store must not redirect partial-target resolution.
  const decoy = { ...target, storePath: configuredStore };
  await accessor.upsertSessionEntryCore(decoy, { sessionId: target.sessionId, updatedAt: 1 });
  const decoyManager = sessions.SessionManager.open(decoy, workspaceDir);
  decoyManager.appendMessage({ role: "user", content: "Unrelated store history", timestamp: 1 });
  decoyManager.flushPendingPersistence();
  const sessionManager = sessions.SessionManager.open(target, workspaceDir);
  await sessionManager.appendModelChange(model.provider, model.id);
  await sessionManager.appendThinkingLevelChange("off");
  // A long-lived session keeps its id across resets, so the archive behind the
  // latest reset stays in the same transcript and must not be hydrated to compact.
  for (let index = 0; index < (options.archivedTurns ?? 0); index += 1) {
    await sessionManager.appendMessageAsync({
      role: "user",
      content: `Archived request ${index}`,
      timestamp: 1,
    });
    await sessionManager.appendMessageAsync(
      createAssistant(model, [{ type: "text", text: `Archived output ${index} `.repeat(6_000) }]),
    );
  }
  if (options.archivedTurns) {
    await sessionManager.appendResetBoundaryAsync("new");
  }
  if (options.previousSummary) {
    await sessionManager.appendMessageAsync({
      role: "user",
      content: "Earlier request",
      timestamp: 1,
    });
    const firstKeptEntryId = sessionManager.getEntries().at(-1)!.id;
    await sessionManager.appendCompactionAsync(options.previousSummary, firstKeptEntryId, 100);
  }
  for (const content of userTurns) {
    sessionManager.appendMessage({ role: "user", content, timestamp: 1 });
    const repeat = Math.max(1, Math.ceil((options.liveOutputChars ?? 0) / (content.length + 11)));
    sessionManager.appendMessage(
      createAssistant(model, [{ type: "text", text: `Recorded: ${content} `.repeat(repeat) }]),
    );
  }
  sessionManager.flushPendingPersistence();
  const originalMessages = sessionManager.buildSessionContext().messages;
  const originalEntries = sessionManager.getEntries();
  const stream = vi.fn<NonNullable<ProviderConfigInput["streamSimple"]>>((activeModel) =>
    createAssistantResultStream(createAssistant(activeModel, [{ type: "text", text: summary }])),
  );
  const authStorage = sessions.AuthStorage.inMemory();
  authStorage.setRuntimeApiKey(model.provider, "test-api-key");
  const modelRegistry = sessions.ModelRegistry.inMemory(authStorage);
  modelRegistry.registerProvider(model.provider, { api: model.api, streamSimple: stream });
  resolveModelMock.mockImplementation((provider = model.provider, modelId = model.id) => ({
    logicalRef: { provider, model: modelId },
    model,
    error: null,
    authStorage,
    modelRegistry,
  }));
  vi.mocked(streamResolution.resolveEmbeddedAgentStream).mockReturnValue({
    streamFn: stream,
    strategy: "session-custom",
  });
  applyExtraParamsToAgentMock.mockReturnValue({
    effectiveExtraParams: { responsesCompactEndpoint: operation === "endpoint" },
  });
  requestPreparedCompaction.mockResolvedValue({
    item: { type: "compaction", id: "cmp_fixture", encrypted_content: "opaque-fixture" },
    output: [{ type: "compaction", id: "cmp_fixture", encrypted_content: "opaque-fixture" }],
    historyMode: "compacted-prefix",
    usage: { input_tokens: 1_000, output_tokens: 200 },
    model,
    replayMetadata: replay.buildOpenAIResponsesReasoningReplayMetadata(model, {
      sessionId: target.sessionId,
    }),
  });
  const runtimeContext = {
    workspaceDir,
    provider: model.provider,
    model: model.id,
    trigger: "manual",
    thinkLevel: "off",
    config: {
      session: { store: configuredStore },
      agents: {
        ownership: "explicit",
        entries: { main: {}, marketing: {} },
        defaults: { compaction: { mode: "default", keepRecentTokens: 1, postIndexSync: "off" } },
      },
    },
  } satisfies ContextEngineRuntimeContext & { config: OpenClawConfig };
  configRuntime.setRuntimeConfigSnapshot(runtimeContext.config);
  const recordCompaction = vi.fn();
  accounting.attachCompactionAccountingRecorder(runtimeContext, { recordCompaction });
  const open = () => sessions.SessionManager.open(target);
  return {
    open,
    reopen: async () => {
      await closeDatabases();
      return open();
    },
    expectDecoyUnchanged: () => {
      expect(sessions.SessionManager.open(decoy).buildSessionContext().messages).toEqual(
        decoyMessages,
      );
    },
    expectOriginalEntries: () => {
      expect(open().getEntries()).toEqual(expect.arrayContaining(originalEntries));
    },
    queuedParams: {
      ...target,
      sessionTarget: target,
      sessionFile: target.sessionKey,
      workspaceDir,
      config: runtimeContext.config,
      provider: model.provider,
      model: model.id,
      agentHarnessId: "openclaw",
      trigger: "manual",
      enqueue: async (task) => await task(),
    } satisfies Parameters<typeof compactQueued>[0],
    delegateParams: {
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
      sessionTarget: target,
      runtimeContext,
    },
    target,
    decoy,
    originalEntries,
    originalMessages,
    runtimeContext,
    stream,
    recordCompaction,
  };
}

describe("direct compactor through the context-engine delegate", () => {
  it.each([
    ["at-boundary", true, undefined, "transcript_bytes", "manual"],
    ["above-boundary", true, undefined, undefined, "manual"],
    ["zero", true, undefined, undefined, "manual"],
    ["at-boundary", false, undefined, undefined, "manual"],
    ["at-boundary", true, "tokens", "tokens", "manual"],
    ["invalid", true, undefined, undefined, "manual"],
    ["at-boundary", true, undefined, undefined, "budget"],
  ] as const)(
    "passes queued byte pressure: limit=%s, enabled=%s, explicit=%s → %s (%s)",
    async (limit, enabled, explicit, expected, trigger) => {
      const fixture = await createFixture("summary");
      const { readSessionTranscriptAccountingAsync } =
        await import("../../gateway/session-transcript-readers.js");
      const snapshot = await readSessionTranscriptAccountingAsync(fixture.target, {
        includeByteSize: true,
        includeUsage: false,
      });
      const byteSize = expectDefined(snapshot.byteSize, "measured active transcript bytes");
      expect(byteSize).toBeGreaterThan(0);
      const maxActiveTranscriptBytes =
        limit === "zero"
          ? 0
          : limit === "invalid"
            ? "invalid"
            : `${byteSize + (limit === "above-boundary" ? 1 : 0)}b`;
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
        config: {
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

  it.each([false, true])(
    "records server checkpoint pressure with foreground budget=%s",
    async (hasBudget) => {
      const fixture = await createFixture("endpoint");
      const compactorPrompt = "Summarize the deployment discussion.";
      buildConfiguredAgentSystemPromptMock.mockReturnValue(compactorPrompt);
      const requestBudget = {
        contextWindow: model.contextWindow,
        reserveTokens: 16_384,
        fixedTokens: 6_000,
        pendingTokens: 2_000,
      };
      accounting.attachCompactionAccountingRecorder(fixture.runtimeContext, {
        ...(hasBudget ? { requestBudget } : {}),
        recordCompaction: fixture.recordCompaction,
      });
      const retainedUsers = userTurns.map((text) => ({
        type: "message" as const,
        role: "user" as const,
        content: [{ type: "input_text" as const, text }],
      }));
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
      const messages = (await fixture.reopen()).buildSessionContext().messages;
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

  it.each(["summary", "endpoint"] as const)(
    "returns durable %s identity without caller-private fields",
    async (operation) => {
      const partial = operation === "summary";
      const fixture = await createFixture(operation, partial);
      const { target } = fixture;
      const sessionTarget = {
        ...(partial ? { agentId: target.agentId, storePath: target.storePath } : target),
        threadId: 0,
        expectedWriterRunId: "caller-private-writer",
        expectedLifecycleRevision: "caller-private-revision",
        unrelatedCapability: "caller-private-capability",
      };
      const result = await delegate({
        ...fixture.delegateParams,
        sessionTarget,
      });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, compacted: true });
      const returned = expectDefined(result.result?.sessionTarget, "resolved compaction identity");
      expect(returned).toEqual({ ...target, threadId: 0 });
      expect(result.result).not.toHaveProperty("sessionFile");
      await closeDatabases();
      const reopened = sessions.SessionManager.open({
        agentId: expectDefined(returned.agentId, "returned agent ID"),
        sessionId: expectDefined(returned.sessionId, "returned session ID"),
        sessionKey: expectDefined(returned.sessionKey, "returned session key"),
        storePath: expectDefined(returned.storePath, "returned store path"),
      });
      expect(reopened.getSessionId()).toBe(target.sessionId);
      expect(reopened.getEntries().length).toBeGreaterThan(0);
      fixture.expectDecoyUnchanged();
      expect(accessor.loadSessionEntry(target)).not.toHaveProperty("compactionCheckpoints");
      expect(accessor.loadSessionEntry(fixture.decoy)).not.toHaveProperty("compactionCheckpoints");
    },
  );

  it("cancels an endpoint request without publishing or rewriting history", async () => {
    const fixture = await createFixture("endpoint");
    const started = createDeferred();
    const stopped = createDeferred();
    const controller = new AbortController();
    const abortReason = new Error("caller cancelled compaction");
    requestPreparedCompaction.mockImplementationOnce(async (_stream, _model, _context, options) => {
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
    });
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
    const reopened = await fixture.reopen();
    expect(reopened.getSessionId()).toBe(fixture.target.sessionId);
    expect(reopened.getEntries()).toEqual(fixture.originalEntries);
    expect(reopened.buildSessionContext().messages).toEqual(fixture.originalMessages);
    expectUncalled(fixture.recordCompaction, hookRunner.runAfterCompaction);
  });

  it.each(["abort", "owner-replaced"] as const)(
    "discards a hydrated compaction transcript after %s before publication",
    async (transition) => {
      const fixture = await createFixture("summary");
      const { historyLane } =
        await import("../../config/sessions/session-transcript-worker-resources.js");
      const { withSessionTranscriptWriteAssertion } =
        await import("../../config/sessions/transcript-write-context.js");
      const received = createDeferred();
      const release = createDeferred();
      const controller = new AbortController();
      let current = true;
      const reason = new Error("compaction preparation no longer current");
      const run = historyLane.pool.run.bind(historyLane.pool);
      const read = vi.spyOn(historyLane.pool, "run").mockImplementation((input, options) => {
        let hydration = false;
        return run(async () => {
          const request = typeof input === "function" ? await input() : input;
          hydration = request.kind === "transcript-hydration";
          return request;
        }, options).then(async (snapshot) => {
          if (hydration) {
            read.mockRestore();
            received.resolve();
            await release.promise;
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
        await Promise.race([
          received.promise,
          pending.then(() => {
            throw new Error("Compaction completed before the native hydration reply");
          }),
        ]);
        if (transition === "abort") {
          controller.abort(reason);
        } else {
          current = false;
        }
        release.resolve();
        expect(await pending).toMatchObject({ ok: false, compacted: false });
        expectUncalled(
          fixture.stream,
          hookRunner.runBeforeCompaction,
          hookRunner.runAfterCompaction,
          fixture.recordCompaction,
        );
        expect((await fixture.reopen()).getEntries()).toEqual(fixture.originalEntries);
      } finally {
        release.resolve();
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
        let host: Parameters<typeof compactQueued>[1] | undefined;
        if (trigger === "manual") {
          const { prepareGatewaySessionCompaction } =
            await import("../../gateway/server-methods/sessions-compaction-runner.js");
          const { persistCompactionBoundaryWithSessionEntryAsync } =
            await import("../../config/sessions/session-accessor.sqlite-compaction-runtime.js");
          const entry = expectDefined(accessor.loadSessionEntry(fixture.target), "fixture session");
          const prepared = await prepareGatewaySessionCompaction({
            agentId: fixture.target.agentId,
            cfg: fixture.runtimeContext.config,
            entry,
            sessionId: fixture.target.sessionId,
            sessionKey: fixture.target.sessionKey,
            sessionStoreKey: fixture.target.sessionKey,
            storePath: fixture.target.storePath,
          });
          const preparedSession = expectDefined(prepared.preparedSession, "prepared session");
          host = {
            preparedSession,
            withCompactionPersistenceAsync: (append) =>
              persistCompactionBoundaryWithSessionEntryAsync(append.scope, {
                prepared: append,
                tokensAfter: append.event.tokensAfter,
                transcriptByteCompactionLatch: null,
              }),
          };
          expect(preparedSession?.sessionManager.getBranch()).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ type: "compaction", summary: previousSummary }),
            ]),
          );
          expect(
            preparedSession?.sessionManager.getBranch().filter((event) => event.type === "message"),
          ).toHaveLength(7);
        }
        const result = await compactQueued(
          { ...fixture.queuedParams, trigger, contextTokenBudget: 32_000 },
          host,
        );
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, compacted: true });
      } finally {
        observed.restore();
      }
      // Header, retained request, full summary, and all six current message entries.
      expect(observed.hydrations[0]).toMatchObject({ kind: "bounded", events: 9 });
      expect(observed.hydrations[0]?.totalEvents).toBeGreaterThan(80);
      const requests = fixture.stream.mock.calls.map((call) => JSON.stringify(call[1]));
      expect(requests.some((request) => request.includes(marker))).toBe(true);
      expect(requests.join("\n")).not.toContain("Archived request");
      const manager = fixture.open();
      expect(manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(2);
      fixture.expectOriginalEntries();
      fixture.expectDecoyUnchanged();
      if (trigger === "manual") {
        const { readSessionEntryReadOnlyInWorker } =
          await import("../../config/sessions/session-entry-read-runtime.js");
        expect(await readSessionEntryReadOnlyInWorker(fixture.target)).toMatchObject({
          compactionCount: 1,
        });
      }
    },
  );

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
      const expectedSession = expectDefined(
        accessor.loadSessionEntry(fixture.target),
        "queued session",
      );
      const hookEntered = createDeferred();
      const releaseHook = createDeferred();
      const expectCommittedTranscript = () => {
        const manager = fixture.open();
        if (operation === "summary") {
          const compactions = manager.getBranch().filter((entry) => entry.type === "compaction");
          expect(compactions).toHaveLength(1);
          const committed = expectDefined(compactions[0], "persisted summary compaction");
          expect(committed.summary).toContain(summary);
          expect(committed.tokensBefore).toBeGreaterThan(0);
          return committed.tokensBefore;
        }
        expect(manager.buildSessionContext().messages.at(-1)).toMatchObject(endpointReplay);
        return 1_000;
      };
      hookRunner.runAfterCompaction.mockImplementationOnce(async () => {
        expectCommittedTranscript();
        hookEntered.resolve();
        await releaseHook.promise;
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
          hookEntered.promise,
          pending.then((result) => {
            throw new Error(
              `Queued compaction returned before its post-commit hook: ${JSON.stringify(result)}`,
            );
          }),
        ]);
        controller.abort(new Error("caller stopped after compaction committed"));
        // Host-owned hooks are awaited rather than cancelled. Finish the hook
        // after abort so the committed result can settle through either owner.
        releaseHook.resolve();
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
        expect(hookRunner.runBeforeCompaction).toHaveBeenCalledOnce();
        expect(hookRunner.runAfterCompaction).toHaveBeenCalledOnce();
        expect(result.result?.tokensBefore).toBe(expectCommittedTranscript());
        fixture.expectDecoyUnchanged();
      } finally {
        releaseHook.resolve();
        await pending.catch(() => undefined);
        await work.drain();
      }
    },
  );
});
