import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { renderConversationEntriesWithinBudget } from "../../../packages/agent-core/src/harness/compaction/conversation-serialization.js";
import {
  collectConversationMessageFact,
  collectConversationRangeDescriptors,
  serializeConversationEntry,
  serializeConversationWithinBudget,
} from "../../../packages/agent-core/src/harness/compaction/utils.js";
import { convertToLlm } from "../../../packages/agent-core/src/harness/messages.js";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.entry.js";
import { persistCompactionBoundaryWithSessionEntryAsync } from "../../config/sessions/session-accessor.sqlite-compaction-runtime.js";
import { replaceTranscriptEventsSync } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { readPreparedSessionCompactionInWorker } from "../../config/sessions/session-compaction-prepared.js";
import type { SessionPreparedCompactionInput } from "../../config/sessions/session-compaction-prepared.types.js";
import { withSessionTranscriptHydrationCaller } from "../../config/sessions/session-transcript-hydration-caller.js";
import { prepareSessionTranscriptHydration } from "../../config/sessions/session-transcript-hydration.js";
import { waitForSessionTranscriptProjection } from "../../config/sessions/session-transcript-reconcile.js";
import {
  historyLane,
  sessionStoreLane,
} from "../../config/sessions/session-transcript-worker-resources.js";
import * as sqliteAdmission from "../../infra/sqlite-database-admission.js";
import { snapshotSqliteReaderMetrics } from "../../infra/sqlite-reader-metrics.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withAgentDatabaseMaintenanceLease } from "../../state/openclaw-agent-db-maintenance-lease.js";
import { ensureOpenClawAgentDatabaseSchema } from "../../state/openclaw-agent-db-schema.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { clearOpenClawDatabaseQuarantine } from "../../state/openclaw-quarantine-store.js";
import { seedOpenClawDatabaseQuarantine } from "../../state/openclaw-quarantine-store.test-support.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  prepareCompactionSafeguardHistory,
  prepareCompactionSafeguardMessages,
  prepareCompactionSafeguardSummary,
} from "../agent-hooks/compaction-safeguard-preparation.js";
import { sanitizeCompactionMessages } from "../compaction-planning.js";
import { prepareCompactionReplay } from "../embedded-agent-runner/prepared-compaction-replay.test-support.js";
import { resolveImageSanitizationLimits } from "../image-sanitization.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { resolveTranscriptPolicy } from "../transcript-policy.js";
import {
  createCompactionReplacementProjector,
  prepareAgentCompactionWork,
} from "./compaction/preparation.js";
import { estimateCompactedRequestTokens } from "./compaction/request-budget.js";
import { createSessionCompactionEntry } from "./session-compaction-persistence.js";
import { sessionScope } from "./session-manager-fixtures.test-support.js";
import { SessionManager, type SessionMessageEntry } from "./session-manager.js";

it("prepares and rerenders captured rows without hydrating summarized history on the host", () =>
  withOpenClawTestState({ label: "prepared-compaction-worker" }, async (state) => {
    const target = makeTarget(state, "prepared-compaction");
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const source = await SessionManager.openAsync(target);
    const model = makeProviderModelFixture({
      id: "fixture",
      provider: "fixture",
      api: "openai-completions",
      baseUrl: "https://example.invalid/v1",
    });
    for (let index = 0; index < 20; index += 1) {
      await source.appendMessageAsync(
        makeUserMessage(index === 1 ? "漢字 source ".repeat(15_000) : "Request " + index, index),
      );
    }
    await source.appendCustomEntryAsync("model-snapshot", {
      timestamp: 1,
      provider: model.provider,
      modelApi: model.api,
      modelId: model.id,
    });
    const before = source.getPersistedEntries();
    const branch = source.getBranch();
    const work = {
      itemId: "prepared-fixture",
      settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 },
      mode: "manual" as const,
      summaryOutputPolicy: "none" as const,
    };
    const expected = prepareAgentCompactionWork(branch, work);
    if (expected.status !== "prepared") {
      throw new Error("Expected compactable native fixture");
    }
    const history = prepareCompactionSafeguardHistory({
      messages: prepareCompactionSafeguardMessages(expected.preparation),
      firstKeptEntryId: expected.preparation.firstKeptEntryId,
      readBranch: () => branch,
    });
    const summary = prepareCompactionSafeguardSummary({
      history,
      preparation: expected.preparation,
      qualityGuardEnabled: true,
      splitTurnContextChars: 8000,
    });
    const operations: string[] = [];
    let hydrationFrames = 0;
    let abortPlan: AbortController | undefined;
    const spies = [historyLane, sessionStoreLane].map(({ pool }) => {
      const run = pool.run.bind(pool);
      return vi.spyOn(pool, "run").mockImplementation((input, options) =>
        run(async () => {
          const request = typeof input === "function" ? await input() : input;
          if (request.kind === "compaction-preparation") {
            operations.push(request.operation.kind);
            if (request.operation.kind === "plan") {
              abortPlan?.abort(new Error("fixture plan cancelled"));
            }
            if (options.onRequest) {
              hydrationFrames += 1;
            }
          }
          return request;
        }, options),
      );
    });
    try {
      const preflight = await readPreparedSessionCompactionInWorker(target, { kind: "preflight" });
      if (preflight.status !== "preflight") {
        throw new Error("Expected native preflight");
      }
      expect(preflight.reads.extractedRows).toBe(before.length);
      const replayOptions = {
        model,
        policy: resolveTranscriptPolicy({
          model,
          modelApi: model.api,
          provider: model.provider,
          modelId: model.id,
        }),
        imageLimits: resolveImageSanitizationLimits(),
        allowedToolNames: [],
        signedThinkingProvider: false,
        allowProviderOwnedThinkingReplay: false,
        isOpenAIResponsesApi: false,
        sessionId: target.sessionId,
        replayEnabled: true,
      };
      const prepared = await readPreparedSessionCompactionInWorker(target, {
        source: preflight.source,
        kind: "plan",
        options: { work, qualityGuardEnabled: true },
        replay: replayOptions,
      });
      if (prepared.status !== "prepared") {
        throw new Error(
          "Native preparation did not produce its bounded plan: " + JSON.stringify(prepared),
        );
      }
      expect(prepared.plan.preparation.firstKeptEntryId).toBe(
        expected.preparation.firstKeptEntryId,
      );
      expect(prepared.plan.retainedSequences.length).toBeLessThan(branch.length);
      expect(prepared.plan).not.toHaveProperty("retained");
      expect(prepared.reads.extractedRows).toBe(0);
      expect(prepared.beforeHookMetrics).toEqual(
        (await prepareCompactionReplay(branch, replayOptions)).beforeHookMetrics,
      );
      expect(hydrationFrames).toBe(0);
      const expectedMessages = convertToLlm(
        sanitizeCompactionMessages(summary.reconciliationMessages),
      );
      for (const maxChars of [4000, 8000, 16_000]) {
        const rendered = await readPreparedSessionCompactionInWorker(target, {
          kind: "render",
          entries: prepared.plan.selections.history,
          version: prepared.version,
          maxChars,
        });
        expect(rendered).toMatchObject({
          kind: "compaction-preparation",
          status: "rendered",
          conversation: serializeConversationWithinBudget(expectedMessages, maxChars),
        });
      }
      expect(operations).toEqual(["preflight", "plan", "render", "render", "render"]);
      abortPlan = new AbortController();
      await expect(
        readPreparedSessionCompactionInWorker(
          target,
          {
            kind: "plan",
            options: { work, qualityGuardEnabled: true },
            replay: {
              model,
              policy: resolveTranscriptPolicy({
                model,
                modelApi: model.api,
                provider: model.provider,
                modelId: model.id,
              }),
              imageLimits: resolveImageSanitizationLimits(),
              allowedToolNames: [],
              signedThinkingProvider: false,
              allowProviderOwnedThinkingReplay: false,
              isOpenAIResponsesApi: false,
              sessionId: target.sessionId,
              replayEnabled: true,
            },
          },
          abortPlan.signal,
        ),
      ).rejects.toThrow();
      abortPlan = undefined;
      expect(source.getPersistedEntries()).toEqual(before);
      const finalizedSummary = prepared.plan.deterministic!;
      const finalizeOperation: Extract<
        SessionPreparedCompactionInput["operation"],
        { kind: "finalize" }
      > = {
        kind: "finalize",
        version: prepared.version,
        retainedSequences: prepared.plan.retainedSequences,
        summary: finalizedSummary,
        work: { itemId: work.itemId },
      };
      const originalReplacement = createCompactionReplacementProjector(branch, work.itemId)(
        finalizedSummary,
        finalizedSummary.summary,
      );
      const budget = {
        contextWindow: 1_000_000,
        reserveTokens: 0,
        fixedTokens: 0,
        pendingTokens: 0,
      };
      await source.appendMessageAsync(
        makeUserMessage("Accepted after planning ".repeat(3000), 100),
      );
      await expect(
        readPreparedSessionCompactionInWorker(target, {
          ...finalizeOperation,
          work: {
            itemId: work.itemId,
            requestBudget: budget,
            requestTokenLimit: estimateCompactedRequestTokens(originalReplacement, budget) + 1,
          },
        }),
      ).rejects.toThrow("finalized compaction exceeds");
      const finalized = await readPreparedSessionCompactionInWorker(target, finalizeOperation);
      if (finalized.status !== "finalized") {
        throw new Error("Expected native finalization");
      }
      const event = createSessionCompactionEntry(
        prepared.leafEntryId,
        finalizedSummary.summary,
        finalizedSummary.firstKeptEntryId,
        finalizedSummary.tokensBefore,
        finalizedSummary.details,
        true,
        { itemId: work.itemId },
        finalized.tokensAfter,
      );
      await persistCompactionBoundaryWithSessionEntryAsync(
        target,
        {
          prepared: {
            scope: target,
            event,
            appendIntent: "active-branch",
            expectedMutationAt: finalized.transcriptMutationAt,
          },
          tokensAfter: finalized.tokensAfter,
          transcriptByteCompactionLatch: null,
        },
        () => {},
      );
      const actual = (await SessionManager.openModelContextAsync(target)).buildSessionContext()
        .messages;
      const expectedKept = createCompactionReplacementProjector(source.getBranch(), work.itemId)(
        finalizedSummary,
        finalizedSummary.summary,
      );
      const withoutTime = (messages: unknown) =>
        JSON.parse(
          JSON.stringify(messages, (key, value) => (key === "timestamp" ? undefined : value)),
        );
      expect(withoutTime(actual)).toEqual(withoutTime(expectedKept));
      expect(actual).toHaveLength(finalized.messageCountAfter);
      expect(replaceTranscriptEventsSync(target, before)).toBe(true);
      await expect(
        readPreparedSessionCompactionInWorker(target, {
          kind: "render",
          entries: prepared.plan.selections.history,
          version: prepared.version,
          maxChars: 4000,
        }),
      ).rejects.toThrow();
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  }));

it("streams oversized compaction history without first materializing it in the reader", () =>
  withOpenClawTestState({ label: "prepared-compaction-working-set" }, async (state) => {
    const target = makeTarget(state, "oversized-preparation");
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const source = await SessionManager.openAsync(target);
    const text = "x".repeat(1024 * 1024);
    const messages = Array.from({ length: 18 }, (_, index) => ({
      type: "message",
      id: "large-" + index,
      parentId: index ? "large-" + (index - 1) : null,
      timestamp: new Date(index).toISOString(),
      message: makeUserMessage(text, index),
    }));
    expect(
      replaceTranscriptEventsSync(target, [source.getPersistedEntries()[0]!, ...messages]),
    ).toBe(true);
    await waitForSessionTranscriptProjection(target);
    const before = await prepareSessionTranscriptHydration(target, { compaction: true }).read();
    if (before.kind !== "bounded" || !before.residentRows) {
      throw new Error("Expected indexed compaction fixture");
    }
    const sequences = before.residentRows.slice(1).map((row) => row.rawSeq);
    const descriptors = collectConversationRangeDescriptors(
      messages.map((entry, index) =>
        collectConversationMessageFact(entry.message, sequences[index]!),
      ),
    );
    const last = sequences.at(-1)!;
    const database = openOpenClawAgentDatabase({ agentId: "main", path: target.storePath });
    const writePayload = database.db.prepare(
      "UPDATE transcript_events SET event_json = ?, event_zstd = NULL WHERE session_id = ? AND seq = ?",
    );
    const model = makeProviderModelFixture({
      id: "fixture",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://example.invalid/v1",
    });
    const planOperation = {
      kind: "plan",
      options: {
        work: {
          itemId: "oversized-plan",
          mode: "manual",
          summaryOutputPolicy: "none",
          settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 },
        },
        qualityGuardEnabled: true,
      },
      replay: {
        model,
        policy: resolveTranscriptPolicy({
          model,
          modelApi: model.api,
          provider: model.provider,
          modelId: model.id,
        }),
        imageLimits: resolveImageSanitizationLimits(),
        allowedToolNames: [],
        signedThinkingProvider: false,
        allowProviderOwnedThinkingReplay: false,
        isOpenAIResponsesApi: true,
        sessionId: target.sessionId,
        replayEnabled: true,
      },
    } satisfies import("../../config/sessions/session-compaction-prepared.types.js").SessionPreparedCompactionInput["operation"];
    const prepared = await readPreparedSessionCompactionInWorker(target, planOperation);
    expect(prepared.status).toBe("prepared");
    expect(prepared.reads.extractedBytes).toBeGreaterThan(16 * 1024 * 1024);
    // Preserve navigation facts while making selected payload acquisition observably fail.
    writePayload.run("{malformed", target.sessionId, last);
    try {
      await expect(readPreparedSessionCompactionInWorker(target, planOperation)).rejects.toThrow(
        /JSON|Unexpected|property/i,
      );
      await expect(
        readPreparedSessionCompactionInWorker(target, {
          kind: "render",
          entries: descriptors,
          version: before.snapshot.version,
          maxChars: 4000,
        }),
      ).rejects.toThrow(/JSON|Unexpected|property/i);
    } finally {
      writePayload.run(JSON.stringify(messages.at(-1)), target.sessionId, last);
    }
    const rendered = await readPreparedSessionCompactionInWorker(target, {
      kind: "render",
      entries: descriptors,
      version: before.snapshot.version,
      maxChars: 4000,
    });
    expect(rendered).toMatchObject({
      kind: "compaction-preparation",
      status: "rendered",
      conversation: serializeConversationWithinBudget(
        messages.map((entry) => entry.message),
        4000,
      ),
    });
    const candidates = new Set<number>();
    renderConversationEntriesWithinBudget(descriptors, 4000, (entry, variant) => {
      candidates.add(entry.source);
      return serializeConversationEntry(
        messages[sequences.indexOf(entry.source)]!.message,
        entry,
        variant,
      );
    });
    const skipped = sequences.find((seq) => !candidates.has(seq))!;
    expect(skipped).toBeDefined();
    writePayload.run("{malformed", target.sessionId, skipped);
    try {
      expect(
        await readPreparedSessionCompactionInWorker(target, {
          kind: "render",
          entries: descriptors,
          version: before.snapshot.version,
          maxChars: 4000,
        }),
      ).toEqual(rendered);
    } finally {
      writePayload.run(
        JSON.stringify(messages[sequences.indexOf(skipped)]),
        target.sessionId,
        skipped,
      );
    }
    // The explicit full-history adapter remains usable by public SDK consumers.
    const hydrated = await prepareSessionTranscriptHydration(target, { compaction: true }).read();
    const events = hydrated.snapshot.events.slice(1);
    expect(events).toHaveLength(messages.length);
    expect(
      events.every(
        (event, index) =>
          isRecord(event) &&
          event.id === "large-" + index &&
          isRecord(event.message) &&
          event.message.content === text,
      ),
    ).toBe(true);
  }));

function makeTarget(state: OpenClawTestState, sessionId: string) {
  return sessionScope(path.join(state.agentDir("main"), "openclaw-agent.sqlite"), sessionId);
}

it("preserves deferred and interleaved hydration callers through real worker reads", () =>
  withOpenClawTestState({ label: "hydration-callers" }, async (state) => {
    const target = makeTarget(state, "attribution");
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const source = await SessionManager.openAsync(target);
    await source.appendMessageAsync(makeUserMessage("synthetic attribution", 1));
    const counts = () =>
      new Map(snapshotSqliteReaderMetrics().map(({ operation, count }) => [operation, count]));
    const before = counts();
    const callers: Array<string | undefined> = [];
    const spies = [historyLane, sessionStoreLane].map(({ pool }) => {
      const run = pool.run.bind(pool);
      return vi.spyOn(pool, "run").mockImplementation((input, options) =>
        run(async () => {
          const request = typeof input === "function" ? await input() : input;
          if (request.kind === "transcript-hydration") {
            callers.push(request.caller);
          }
          return request;
        }, options),
      );
    });
    try {
      const preview = withSessionTranscriptHydrationCaller("preview", () =>
        prepareSessionTranscriptHydration(target),
      );
      const exported = withSessionTranscriptHydrationCaller("export", () =>
        prepareSessionTranscriptHydration(target),
      );
      const reads = await withSessionTranscriptHydrationCaller("correction", () =>
        Promise.all([preview.read(), exported.read()]),
      );
      for (const read of reads) {
        expect(read.snapshot.events).toEqual(source.getPersistedEntries());
      }
      await source.reloadPersistedTranscriptAsync();
      await SessionManager.openAsync(target);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
    expect(callers.toSorted((left, right) => String(left).localeCompare(String(right)))).toEqual([
      "export",
      "model-reload",
      "preview",
      "session-manager",
    ]);
    // Physical reader counters are available only through Linux procfs.
    if (process.platform === "linux") {
      await expect
        .poll(() => {
          const after = counts();
          return ["preview", "export", "model-reload", "session-manager", "correction"].map(
            (caller) => {
              const operation = `sessions.transcript-hydration.${caller}`;
              return (after.get(operation) ?? 0) - (before.get(operation) ?? 0);
            },
          );
        })
        .toEqual([1, 1, 1, 1, 0]);
    }
  }));

for (const cancelled of ["leader", "follower"] as const) {
  it(`cancels a joined bounded hydration ${cancelled} without cancelling its peer`, ({ signal }) =>
    withOpenClawTestState({ label: `hydration-cancel-${cancelled}` }, async (state) => {
      const target = makeTarget(state, "joined-hydration");
      await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
      const source = await SessionManager.openAsync(target);
      await source.appendMessageAsync(makeUserMessage("shared bounded context", 1));
      const entered = createDeferredCore();
      const joined = createDeferredCore();
      const release = createDeferredCore();
      const controllers = [new AbortController(), new AbortController()];
      const run = historyLane.pool.run.bind(historyLane.pool);
      let dispatches = 0;
      const transport = vi.spyOn(historyLane.pool, "run").mockImplementation((input, options) =>
        run(async () => {
          const request = typeof input === "function" ? await input() : input;
          if (request.kind === "transcript-hydration" && ++dispatches === 1) {
            entered.resolve();
            await release.promise;
          }
          return request;
        }, options),
      );
      const read = (index: number) =>
        prepareSessionTranscriptHydration(
          target,
          { maxBytes: 8192, maxEvents: 20 },
          controllers[index]!.signal,
        ).read();
      const leader = read(0);
      const pending = [leader];
      try {
        await withinTest(
          awaitGateBeforeSettlement(entered.promise, leader, "Hydration missed transport gate"),
          signal,
        );
        const revision = sqliteAdmission.readSqliteDatabaseScopedWriteTokenForPath;
        const observer = vi
          .spyOn(sqliteAdmission, "readSqliteDatabaseScopedWriteTokenForPath")
          .mockImplementation((location, scopes) => {
            const token = revision(location, scopes);
            const last = Array.isArray(scopes) ? scopes.at(-1) : undefined;
            if (isRecord(last) && last.sessionId === target.sessionId) {
              joined.resolve();
            }
            return token;
          });
        try {
          const follower = read(1);
          pending.push(follower);
          await withinTest(
            awaitGateBeforeSettlement(joined.promise, follower, "Follower missed revision join"),
            signal,
          );
          const index = cancelled === "leader" ? 0 : 1;
          const reason = new Error(`cancelled ${cancelled}`);
          expect(dispatches).toBe(1);
          const refused = expect(pending[index]).rejects.toBe(reason);
          controllers[index]!.abort(reason);
          // Cancellation must settle while the shared transport remains held.
          await withinTest(refused, signal);
          release.resolve();
          const survivor = await withinTest(pending[1 - index]!, signal);
          expect(survivor.snapshot.events).toEqual(source.getPersistedEntries());
          expect(dispatches).toBe(cancelled === "leader" ? 2 : 1);
        } finally {
          observer.mockRestore();
        }
      } finally {
        release.resolve();
        await Promise.allSettled(pending);
        transport.mockRestore();
      }
    }));
}

function retainedManager(timestamp: number) {
  const manager = SessionManager.inMemory("/retained");
  manager.appendMessage(makeUserMessage("keep the original view", timestamp));
  return { manager, before: { ...managerView(manager), cwd: "/retained", persisted: false } };
}

function managerView(manager: SessionManager) {
  return {
    entries: manager.getPersistedEntries(),
    target: manager.getSessionTarget(),
    cwd: manager.getCwd(),
    persisted: manager.isPersisted(),
  };
}

async function seedTranscript(state: OpenClawTestState) {
  const target = makeTarget(state, "streamed-hydration");
  await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
  const source = SessionManager.open(target, "/stored");
  // Three-byte characters cross the transport's binary frame boundaries.
  const text = "漢".repeat(400_000);
  ["first complete message", text, text, "last complete message"].forEach((content, index) =>
    source.appendMessage(makeUserMessage(content, index + 1)),
  );
  await waitForSessionTranscriptProjection(target);
  return { target, entries: source.getPersistedEntries() };
}

function holdFirstChunk() {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const run = historyLane.pool.run.bind(historyLane.pool);
  const observed = { chunks: 0, splitUtf8: false };
  const spy = vi.spyOn(historyLane.pool, "run").mockImplementation((input, options) => {
    const receive = options.onRequest;
    if (!receive) {
      return run(input, options);
    }
    return run(input, {
      ...options,
      onRequest: async (value, context) => {
        if (
          !isRecord(value) ||
          value.kind !== "transcript-hydration-chunk" ||
          !Array.isArray(value.frames)
        ) {
          return receive(value, context);
        }
        observed.chunks++;
        for (const frame of value.frames) {
          if (isRecord(frame) && frame.data instanceof Uint8Array) {
            try {
              new TextDecoder("utf-8", { fatal: true }).decode(frame.data);
            } catch {
              observed.splitUtf8 = true;
            }
          }
        }
        const response = await receive(value, context);
        if (observed.chunks === 1) {
          entered.resolve();
          await release.promise;
        }
        return response;
      },
    });
  });
  return {
    release: () => release.resolve(),
    restore: () => spy.mockRestore(),
    observed,
    wait: (pending: Promise<unknown>) =>
      awaitGateBeforeSettlement(
        entered.promise,
        pending,
        "Hydration finished without transferring a transcript chunk",
      ),
  };
}

it("rejects a persisted quarantine through the history worker without retargeting the manager", async () => {
  await withOpenClawTestState({ label: "session-hydration-stream-quarantine" }, async (state) => {
    const target = makeTarget(state, "quarantined-hydration");
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    SessionManager.open(target).appendMessage(makeUserMessage("quarantined history", 1));
    await waitForSessionTranscriptProjection(target);
    await closeOpenClawAgentDatabaseByPathAsync(target.storePath);
    const reason = "synthetic persisted hydration quarantine";
    seedOpenClawDatabaseQuarantine({
      kind: "agent",
      path: target.storePath,
      env: state.env,
      reason,
    });
    const { manager, before } = retainedManager(2);
    // The closed database makes this a cold read, which runs on the target-discovery lane.
    const dispatch = vi.spyOn(sessionStoreLane.pool, "run");
    try {
      const failure = await manager.setSessionTargetAsync(target).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).toMatchObject({
        name: "SqliteIntegrityError",
        message: expect.stringContaining(reason),
      });
      expect(dispatch).toHaveBeenCalledOnce();
      expect(await dispatch.mock.results[0]?.value).toMatchObject({
        ok: false,
        error: { kind: "read-error" },
      });
      expect(managerView(manager)).toEqual(before);
      expect(sessionStoreLane.pool.getSnapshot()).toMatchObject({
        activeTasks: 0,
        pendingTasks: 0,
      });
    } finally {
      dispatch.mockRestore();
      expect(clearOpenClawDatabaseQuarantine(target.storePath, { env: state.env })).toBe(true);
    }
  });
});

it.each(["UTF-16le", "UTF-16be"] as const)(
  "hydrates canonical %s transcripts with the same Unicode content as the synchronous reader",
  async (encoding) => {
    await withOpenClawTestState({ label: "session-hydration-stream-encoding" }, async (state) => {
      const target = makeTarget(state, "encoded-hydration");
      target.storePath = state.path("utf16-agent.sqlite");
      const database = new DatabaseSync(target.storePath);
      try {
        database.exec(`PRAGMA encoding = '${encoding}'`);
        await withAgentDatabaseMaintenanceLease({ env: state.env }, async () => {
          ensureOpenClawAgentDatabaseSchema(database, {
            agentId: target.agentId,
            path: target.storePath,
            env: state.env,
          });
        });
        expect(database.prepare("PRAGMA encoding").get()?.encoding).toBe(encoding);
      } finally {
        database.close();
      }
      await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
      const source = SessionManager.open(target, "/stored");
      const message = makeUserMessage("雪 🦞 café العربية \uFEFF preserved", 1);
      source.appendMessage(message);
      await waitForSessionTranscriptProjection(target);
      const expected = SessionManager.open(target).getPersistedEntries();
      const hydrated = await SessionManager.openAsync(target);
      expect(hydrated.getPersistedEntries()).toEqual(expected);
      expect(hydrated.buildSessionContext().messages).toEqual([message]);
    });
  },
);

it("hydrates events below, on, and above byte-slice boundaries without dropping their successors", async () => {
  await withOpenClawTestState({ label: "session-hydration-stream-boundaries" }, async (state) => {
    const target = makeTarget(state, "boundary-hydration");
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const entries = SessionManager.open(target).getPersistedEntries();
    let parentId: string | null = null;
    for (const size of [65_535, 65_536, 65_537, 131_072]) {
      const event: SessionMessageEntry = {
        type: "message",
        id: `boundary-${size}`,
        parentId,
        timestamp: new Date(size).toISOString(),
        message: makeUserMessage("", size),
      };
      event.message = makeUserMessage(
        "x".repeat(size - Buffer.byteLength(JSON.stringify(event))),
        size,
      );
      expect(Buffer.byteLength(JSON.stringify(event))).toBe(size);
      entries.push(event);
      parentId = event.id;
    }
    expect(replaceTranscriptEventsSync(target, entries)).toBe(true);
    expect((await SessionManager.openAsync(target)).getPersistedEntries()).toEqual(entries);
  });
});

it("hydrates one complete UTF-8 snapshot while a writer replaces rows between chunks", async () => {
  await withOpenClawTestState({ label: "session-hydration-stream-snapshot" }, async (state) => {
    const { target, entries } = await seedTranscript(state);
    const gate = holdFirstChunk();
    const pending = SessionManager.openAsync(target);
    try {
      await gate.wait(pending);
      const replacement = SessionManager.inMemory("/replacement");
      replacement.appendMessage(makeUserMessage("replacement history", 5));
      const replacementEntries = replacement
        .getPersistedEntries()
        .map((entry) =>
          isRecord(entry) && entry.type === "session"
            ? Object.assign(entry, { id: target.sessionId })
            : entry,
        );
      // The hot fixture writer must not queue cold preflight on the history worker
      // whose snapshot this test deliberately holds until the write completes.
      expect(replaceTranscriptEventsSync(target, replacementEntries)).toBe(true);
      gate.release();
      const hydrated = await pending;
      expect(hydrated.getPersistedEntries()).toEqual(entries);
      expect(gate.observed.chunks).toBeGreaterThan(1);
      expect(gate.observed.splitUtf8).toBe(true);
      expect((await SessionManager.openAsync(target)).getPersistedEntries()).toEqual(
        replacementEntries,
      );
    } finally {
      gate.release();
      gate.restore();
      await Promise.allSettled([pending]);
    }
  });
});

it.each([
  { label: "cancellation", corrupt: undefined },
  { label: "malformed JSON", corrupt: "{malformed" },
  { label: "leading BOM", corrupt: "\uFEFF{}" },
])("preserves the manager after streaming $label", async ({ corrupt }) => {
  await withOpenClawTestState({ label: "session-hydration-stream-failure" }, async (state) => {
    const { target, entries } = await seedTranscript(state);
    if (corrupt !== undefined) {
      const database = openOpenClawAgentDatabase({ agentId: "main", path: target.storePath });
      // Corrupt only the final fixture row after its canonical write has settled.
      database.db
        .prepare(
          `UPDATE transcript_events SET event_json = ?, event_zstd = NULL,
           event_utf8_bytes = ?, navigation_json = NULL
           WHERE session_id = ? AND seq = (
             SELECT MAX(seq) FROM transcript_events WHERE session_id = ?
           )`,
        )
        .run(corrupt, Buffer.byteLength(corrupt), target.sessionId, target.sessionId);
      expect(() => SessionManager.open(target)).toThrow(SyntaxError);
    }
    const { manager, before } = retainedManager(10);
    const controller = new AbortController();
    const reason = new Error("cancelled streaming hydration");
    const gate = holdFirstChunk();
    const pending = manager.setSessionTargetAsync(
      target,
      corrupt === undefined ? controller.signal : undefined,
    );
    const refused =
      corrupt === undefined
        ? expect(pending).rejects.toBe(reason)
        : expect(pending).rejects.toThrow();
    try {
      await gate.wait(pending);
      if (corrupt === undefined) {
        controller.abort(reason);
      } else {
        gate.release();
      }
      await refused;
      if (corrupt === undefined) {
        expect(historyLane.pool.getSnapshot()).toMatchObject({
          workers: 0,
          activeTasks: 0,
          pendingTasks: 0,
        });
      } else {
        expect(gate.observed.chunks).toBeGreaterThan(1);
      }
      expect(managerView(manager)).toEqual(before);
      if (corrupt === undefined) {
        gate.release();
        await manager.setSessionTargetAsync(target);
        expect(manager.getPersistedEntries()).toEqual(entries);
      }
    } finally {
      gate.release();
      gate.restore();
      await Promise.allSettled([pending, refused]);
    }
  });
});

it("renders placed background context from its captured projection source in the worker", () =>
  withOpenClawTestState({ label: "prepared-background-context" }, async (state) => {
    const target = makeTarget(state, "background-context");
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const manager = await SessionManager.openAsync(target);
    const tool = {
      role: "toolResult" as const,
      toolCallId: "read-1",
      toolName: "read",
      content: [{ type: "text" as const, text: "read output" }],
      isError: false,
      timestamp: 0,
    };
    const earlier = await manager.appendMessageAsync(tool);
    if (!earlier) {
      throw new Error("Tool fixture did not append");
    }
    await manager.appendCompactionAsync("Prior accepted work", earlier, 1000);
    const backgroundMessage: Parameters<typeof manager.appendMessageAsync>[0] & {
      excludeFromContext: true;
      openclawModelPlacement: "pending";
    } = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Background result complete: keep this finding.",
        },
      ],
      api: "test",
      provider: "openclaw",
      model: "automation-result",
      stopReason: "stop",
      timestamp: 0,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      excludeFromContext: true,
      openclawModelPlacement: "pending",
    };
    const pending = await manager.appendMessageAsync(backgroundMessage);
    await manager.appendCustomEntryAsync("openclaw.background-result-placement", {
      afterEntryId: pending,
      resultEntryIds: [pending],
    });
    await manager.appendMessageAsync(tool);
    await manager.appendMessageAsync(makeUserMessage("Latest request", 1));
    const model = makeProviderModelFixture({
      id: "fixture",
      provider: "fixture",
      api: "openai-completions",
      baseUrl: "https://example.invalid/v1",
    });
    const prepared = await readPreparedSessionCompactionInWorker(target, {
      kind: "plan",
      options: {
        work: {
          itemId: "background",
          mode: "manual",
          summaryOutputPolicy: "none",
          settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 0 },
        },
        qualityGuardEnabled: true,
      },
      replay: {
        model,
        policy: resolveTranscriptPolicy({
          model,
          modelApi: model.api,
          provider: model.provider,
          modelId: model.id,
        }),
        imageLimits: resolveImageSanitizationLimits(),
        allowedToolNames: [],
        signedThinkingProvider: false,
        allowProviderOwnedThinkingReplay: false,
        isOpenAIResponsesApi: false,
        sessionId: target.sessionId,
        replayEnabled: true,
      },
    });
    if (prepared.status !== "prepared") {
      throw new Error("Expected prepared background context");
    }
    expect(prepared.plan.facts.history.usedPreparationRange).toBe(true);
    const rendered = await readPreparedSessionCompactionInWorker(target, {
      kind: "render",
      entries: prepared.plan.selections.history,
      version: prepared.version,
      maxChars: 4000,
    });
    expect(rendered).toMatchObject({
      status: "rendered",
      conversation: {
        text: "[Tool result]: read output\n\n[Assistant]: Background result complete: keep this finding.\n\n[Tool result]: read output",
        omittedEntries: 0,
        trimmedEntries: 0,
      },
    });
  }));
