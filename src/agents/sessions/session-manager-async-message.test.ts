import path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import {
  appendTranscriptMessageSync,
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { stageSessionPendingInput } from "../../config/sessions/session-accessor.pending-inputs.js";
import { retainPreparedSessionSharingFacts } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { kickSessionEntryMaintenanceAfterWrite } from "../../config/sessions/session-accessor.sqlite-maintenance-kick.js";
import { readTranscriptEventRows } from "../../config/sessions/session-accessor.sqlite-read.js";
import * as reclamationRun from "../../config/sessions/session-accessor.sqlite-reclamation-run.js";
import { SqliteTranscriptMutationConflictError } from "../../config/sessions/session-mutation-conflict-error.js";
import type { SessionMentionInvitation } from "../../config/sessions/session-sharing-authority.types.js";
import { readSessionMembersInWorker } from "../../config/sessions/session-sharing-store.js";
import { resolveMaintenanceConfigFromInput } from "../../config/sessions/store-maintenance.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import {
  attachRuntimeUserTurnTranscriptRecorder,
  withCurrentRuntimeUserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript-runtime-context.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { assertOpenClawAgentWriterReleased } from "../../state/openclaw-agent-write-admission-state.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { isRecordedModelFallbackStop } from "../model-fallback-stop.js";
import { withSessionManagerAppend } from "./session-manager-append-admission.js";
import { sessionManagerReadMessageAnchor } from "./session-manager-message-anchor.js";
import * as metadataRuntime from "./session-manager-metadata-runtime.js";
import { withSelectedTranscriptReader } from "./session-manager-reader.test-support.js";
import { SessionManager } from "./session-manager.js";

let state: OpenClawTestState;
beforeAll(async () => {
  state = await createOpenClawTestState({ label: "async-message-worker" });
});
afterAll(async () => {
  await state.cleanup();
});

async function fixture(testState: OpenClawTestState, name: string) {
  const target = {
    agentId: "main",
    sessionId: name,
    sessionKey: `agent:main:${name}`,
    storePath: path.join(testState.agentDir("main"), "openclaw-agent.sqlite"),
  };
  await upsertSessionEntryCore(target, { sessionId: name, updatedAt: 1 });
  const manager = await SessionManager.openAsync(target, testState.workspaceDir);
  return { target, manager };
}

const user = (key: string) => ({
  role: "user" as const,
  content: `Synthetic input ${key}`,
  timestamp: 1,
  idempotencyKey: `${key}:user`,
});

const toolResult = <T extends object>(overrides: T) => ({
  role: "toolResult" as const,
  toolCallId: "result",
  toolName: "lookup",
  content: [{ type: "text" as const, text: "Synthetic result" }],
  isError: false,
  timestamp: 2,
  ...overrides,
});

type MetadataWorker = Parameters<
  Parameters<typeof metadataRuntime.withSessionMetadataWorker>[3]
>[0];

function interceptWorker(wrap: (worker: MetadataWorker) => MetadataWorker) {
  const original = metadataRuntime.withSessionMetadataWorker;
  return vi
    .spyOn(metadataRuntime, "withSessionMetadataWorker")
    .mockImplementation((options, database, assertCurrent, operation, controls) =>
      original(options, database, assertCurrent, (worker) => operation(wrap(worker)), controls),
    );
}

function afterMetadataReceipt(after: () => void) {
  const original = metadataRuntime.withSessionMetadataWorker;
  return vi
    .spyOn(metadataRuntime, "withSessionMetadataWorker")
    .mockImplementation(async (...args) => {
      const result = await original(...args);
      after();
      return result;
    });
}

it.for(["protected", "below cap protected insert"] as const)(
  "resumes idle protected-store maintenance after a lazy worker creates a session (starting state: %s)",
  async (startingState, { signal }) => {
    const belowCap = startingState.startsWith("below cap");
    const storePath = state.statePath(`lazy-maintenance-${startingState}.sqlite`);
    const scope = { agentId: "main", path: storePath };
    const protectedKey = "agent:main:lazy-protected";
    const updatedAt = Date.now();
    openOpenClawAgentDatabase(scope);
    runOpenClawAgentWriteTransaction((database) => {
      for (const key of [protectedKey, ...(belowCap ? [] : ["agent:main:lazy-other-protected"])]) {
        writeSessionEntry(database, key, {
          sessionId: key,
          updatedAt,
          modelSelectionLocked: true,
        });
      }
    }, scope);
    const request = {
      activeSessionKey: protectedKey,
      archiveDirectory: path.join(path.dirname(storePath), "lazy-archives"),
      maintenanceConfig: {
        ...resolveMaintenanceConfigFromInput(),
        maxEntries: belowCap ? 2 : 1,
        pruneAfterMs: 86_400_000,
        archiveDashboardAfterMs: null,
        preserveRecentMs: null,
      },
      scope,
      storePath,
    };
    const settled = createDeferred();
    const archived = createDeferred();
    const run = reclamationRun.runSqliteSessionReclamation;
    let passes = 0;
    const observe = vi
      .spyOn(reclamationRun, "runSqliteSessionReclamation")
      .mockImplementation(async (params) => {
        if (params.plan.kind === "maintenance-plan") {
          passes++;
        }
        const result = await run(params);
        if (result.kind === "maintenance-plan") {
          if (belowCap && result.value.archived === 0) {
            expect(result.value.durableNoCandidates).not.toBe(true);
            settled.resolve();
          }
          if (result.value.durableNoCandidates === true) {
            settled.resolve();
          }
          if (result.value.archived > 0) {
            archived.resolve();
          }
        }
        return result;
      });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      kickSessionEntryMaintenanceAfterWrite(request);
      await withinTest(settled.promise, signal);
      await yieldToEventLoop();
      const protectedPasses = passes;
      kickSessionEntryMaintenanceAfterWrite(request);
      await vi.advanceTimersByTimeAsync(1_001);
      expect(passes).toBe(protectedPasses);

      const target = {
        agentId: "main",
        storePath,
        sessionKey:
          startingState === "below cap protected insert"
            ? "agent:main:direct:lazy-protected-insert"
            : "agent:main:lazy-eligible",
        sessionId: "lazy-eligible",
      };
      const firstKey = belowCap ? "lazy-first" : "direct:lazy-protected-insert";
      const firstTarget = {
        ...target,
        sessionKey: `agent:main:${firstKey}`,
        sessionId: firstKey,
      };
      const first = await SessionManager.openAsync(firstTarget, state.workspaceDir);
      await first.appendMessageAsync(user("lazy-maintenance-first"));
      await yieldToEventLoop();
      await vi.advanceTimersByTimeAsync(1_001);
      expect(passes).toBe(protectedPasses);
      expect(loadSessionEntry(firstTarget)?.archivedAt).toBeUndefined();
      const victim = belowCap ? firstTarget : target;
      const manager = await SessionManager.openAsync(target, state.workspaceDir);
      await manager.appendMessageAsync(user("lazy-maintenance"));
      expect(loadSessionEntry(target)?.sessionId).toBe(target.sessionId);
      await yieldToEventLoop();
      await vi.advanceTimersByTimeAsync(1_001);
      expect(passes).toBeGreaterThan(protectedPasses);
      await withinTest(archived.promise, signal);
      expect(loadSessionEntry(victim)?.archiveReason).toBe("active-session-cap");
      if (startingState === "below cap protected insert") {
        expect(loadSessionEntry(target)?.archivedAt).toBeUndefined();
      }
      expect((await loadTranscriptEvents(target)).at(-1)).toMatchObject({
        message: user("lazy-maintenance"),
      });
    } finally {
      vi.useRealTimers();
      await closeOpenClawAgentDatabaseByPathAsync(storePath);
      observe.mockRestore();
    }
  },
);

it.each([1, 2])(
  "rereads and retries one local append after a transcript conflict (conflicting writes: %s)",
  async (conflicts) => {
    const { target, manager } = await fixture(state, `mutation-conflicts-${conflicts}`);
    await manager.appendMessageAsync(user("seed"));
    let appends = 0;
    let mutationReads = 0;
    const failures: unknown[] = [];
    const spy = interceptWorker((worker) => ({
      execute: async (command, commandOptions) => {
        if (command.type === "session.metadata.mutation") {
          mutationReads++;
        }
        if (command.type === "session.metadata.append" && ++appends <= conflicts) {
          // The synchronous SDK can commit after host preparation but before the worker.
          expect(
            appendTranscriptMessageSync(target, {
              eventId: `concurrent-${appends}`,
              message: user(`concurrent-${appends}`),
            }).ok,
          ).toBe(true);
        }
        try {
          return await worker.execute(command, commandOptions);
        } catch (error) {
          failures.push(error);
          throw error;
        }
      },
    }));
    let failure: unknown;
    let entryId: string | undefined;
    try {
      entryId = await manager.appendMessageAsync(user("accepted")).catch((error: unknown) => {
        failure = error;
        return undefined;
      });
    } finally {
      spy.mockRestore();
    }
    expect(appends).toBe(2);
    expect(mutationReads).toBe(1);
    expect(failures).toHaveLength(conflicts);
    for (const error of failures) {
      expect(error).toBeInstanceOf(SqliteTranscriptMutationConflictError);
    }
    const events = await loadTranscriptEvents(target);
    expect(events.slice(2, 2 + conflicts)).toMatchObject(
      Array.from({ length: conflicts }, (_, index) => ({
        id: `concurrent-${index + 1}`,
        message: user(`concurrent-${index + 1}`),
      })),
    );
    if (conflicts === 1) {
      expect(failure).toBeUndefined();
      expect(events).toHaveLength(4);
      expect(events.at(-1)).toMatchObject({
        id: entryId,
        parentId: "concurrent-1",
        message: user("accepted"),
      });
      expect(manager.getPersistedEntries()).toEqual(events);
    } else {
      expect(failure).toBeInstanceOf(SqliteTranscriptMutationConflictError);
      expect(events).toHaveLength(4);
      expect(entryId).toBeUndefined();
    }
  },
);

it("keeps a newer user intact when a prepared tool result cannot rebase", async () => {
  const { target, manager } = await fixture(state, "superseded-tool-result");
  await manager.appendMessageAsync(user("seed"));
  expect(
    appendTranscriptMessageSync(target, {
      eventId: "newer-user",
      message: user("newer"),
    }).ok,
  ).toBe(true);
  const before = await loadTranscriptEvents(target);
  await expect(
    manager.appendMessageAsync(
      toolResult({
        toolCallId: "superseded-result",
        content: [{ type: "text" as const, text: "Prepared for the older user" }],
      }),
    ),
  ).rejects.toBeInstanceOf(SqliteTranscriptMutationConflictError);
  expect(await loadTranscriptEvents(target)).toEqual(before);
  expect(manager.getEntries()).toHaveLength(1);
});

it("shares one frozen tool-result graph across append receipts, transcript views, and prompt history", async () => {
  const { target, manager } = await fixture(state, "shared-tool-results");
  const seed = await manager.appendMessageWithTranscriptAnchorAsync(user("shared-results"));
  const text = "Synthetic result line with Unicode: 🦞\n".repeat(1024);
  const messages = Array.from({ length: 3 }, (_, index) =>
    toolResult({
      toolCallId: `large-${index}`,
      toolName: "read",
      content: [{ type: "text" as const, text }],
      details: { rows: [{ index, values: [index, index + 1] }] },
      timestamp: index + 2,
    }),
  );
  const originalMessages = structuredClone(messages);
  const originalGraphs = messages.map((message) => ({
    content: message.content,
    block: message.content[0],
    details: message.details,
    rows: message.details.rows,
    row: message.details.rows[0],
    values: message.details.rows[0]!.values,
  }));
  const receipts: Array<
    Awaited<ReturnType<SessionManager["appendMessageWithTranscriptAnchorAsync"]>>
  > = [];
  for (const message of messages) {
    receipts.push(await manager.appendMessageWithTranscriptAnchorAsync(message));
  }
  const entries = receipts.map(({ entryId }) => {
    const entry = manager.getEntry(entryId);
    if (entry?.type !== "message") {
      throw new Error("Expected committed tool-result entry");
    }
    return entry;
  });
  const database = openOpenClawAgentDatabase({ agentId: target.agentId, path: target.storePath });
  expect(readTranscriptEventRows(database, target.sessionId).slice(-messages.length)).toEqual(
    entries.map((entry, index) => ({
      seq: index + 2,
      eventJson: JSON.stringify({
        type: "message",
        id: receipts[index]!.entryId,
        parentId: index === 0 ? seed.entryId : receipts[index - 1]!.entryId,
        timestamp: entry.timestamp,
        message: originalMessages[index],
      }),
    })),
  );
  const context = manager.buildSessionContext().messages.slice(-messages.length);
  for (const [index, message] of messages.entries()) {
    const original = originalGraphs[index]!;
    expect(receipts[index]!.message).toBe(message);
    expect(entries[index]!.message).toBe(message);
    expect(context[index]).toBe(message);
    expect(message.content).toBe(original.content);
    expect(message.content[0]).toBe(original.block);
    expect(message.details).toBe(original.details);
    expect(message.details.rows).toBe(original.rows);
    expect(message.details.rows[0]).toBe(original.row);
    expect(message.details.rows[0]!.values).toBe(original.values);
    for (const value of [message, ...Object.values(original)]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
  }
  expect(() => {
    messages[0]!.content[0]!.text = "mutated after append";
  }).toThrow(TypeError);
  expect(() => messages[0]!.details.rows[0]!.values.push(99)).toThrow(TypeError);
});

it.each(["message", "custom"] as const)(
  "captures %s data before queued admission and keeps worker receipts consistent",
  async (family) => {
    const { target, manager } = await fixture(state, `captured-${family}`);
    await manager.appendMessageAsync(user(`captured-${family}`));
    const nested = { value: "captured" };
    const data = { nested };
    const message = toolResult({
      toolCallId: "captured-result",
      content: [{ type: "text" as const, text: "Captured result" }],
      details: data,
    });
    let appends = 0;
    let workerMutation: boolean | undefined;
    const spy = interceptWorker((worker) => ({
      execute: (command, commandOptions) => {
        const pending = worker.execute(command, commandOptions);
        if (command.type === "session.metadata.append" && ++appends === 2) {
          workerMutation = Reflect.set(nested, "value", "worker mutation");
        }
        return pending;
      },
    }));
    const blocker = manager.appendCustomEntryAsync("queued-before-capture");
    const pending =
      family === "message"
        ? manager.appendMessageWithTranscriptAnchorAsync(message)
        : manager.appendCustomEntryAsync("captured", data);
    const queuedMutation = Reflect.set(nested, "value", "queued mutation");
    try {
      await blocker;
      const receipt = await pending;
      const entryId = typeof receipt === "string" ? receipt : receipt.entryId;
      const expectedData = { nested: { value: "captured" } };
      const expected =
        family === "message" ? { message: { details: expectedData } } : { data: expectedData };
      expect(manager.getEntry(entryId)).toMatchObject(expected);
      expect((await loadTranscriptEvents(target)).at(-1)).toMatchObject(expected);
      if (typeof receipt !== "string") {
        expect(receipt.message).toHaveProperty("details", expectedData);
      }
      expect([queuedMutation, workerMutation]).toEqual([false, false]);
    } finally {
      await Promise.allSettled([blocker, pending]);
      spy.mockRestore();
    }
  },
);

it("captures raw persist envelope fields before asynchronous admission", async () => {
  const { target, manager } = await fixture(state, "captured-raw-envelope");
  const seed = await manager.appendMessageWithTranscriptAnchorAsync(user("raw-envelope"));
  const raw = {
    type: "custom" as const,
    customType: "captured-envelope",
    id: "original-raw-id",
    parentId: seed.entryId,
    timestamp: new Date(0).toISOString(),
    data: { value: "captured" },
  };
  const expected = { ...raw };
  const pending = manager.persistAsync(raw);
  Reflect.set(raw, "id", "mutated-raw-id");
  Reflect.set(raw, "parentId", null);
  await pending;
  await manager.reloadPersistedTranscriptAsync();
  expect(manager.getEntry("original-raw-id")).toEqual(expected);
  expect(manager.getEntry("mutated-raw-id")).toBeUndefined();
  expect((await loadTranscriptEvents(target)).at(-1)).toEqual(expected);
});

it("persists the native first content getter result before provenance reads", async () => {
  const { target, manager } = await fixture(state, "content-getter-order");
  await manager.appendMessageAsync(user("content-getter-order"));
  let reads = 0;
  const receipt = await manager.appendMessageWithTranscriptAnchorAsync({
    role: "toolResult",
    toolCallId: "getter-result",
    toolName: "lookup",
    get content() {
      return [{ type: "text" as const, text: `Read ${++reads}` }];
    },
    isError: false,
    timestamp: 2,
  });
  const expected = [{ type: "text", text: "Read 1" }];
  expect(receipt.message).toHaveProperty("content", expected);
  expect((await loadTranscriptEvents(target)).at(-1)).toMatchObject({
    message: { content: expected },
  });
});

it("expands message toJSON with its envelope key without changing tool text", async () => {
  const { target, manager } = await fixture(state, "message-json-redaction");
  await manager.appendMessageAsync(user("json-redaction"));
  const message = toolResult({
    toolCallId: "json-result",
    content: [],
    toJSON(key: string) {
      return toolResult({
        toolCallId: "json-result",
        content: [{ type: "text" as const, text: "opaque(abcdefghijklmnopqrst)" }],
        details: { serializationKey: key },
      });
    },
  });
  const committed = await manager.appendMessageWithTranscriptAnchorAsync(message, {
    config: { logging: { redactPatterns: [String.raw`/opaque\(([^)]+)\)/g`] } },
  });
  const expected = {
    role: "toolResult",
    toolCallId: "json-result",
    toolName: "lookup",
    content: [{ type: "text", text: "opaque(abcdefghijklmnopqrst)" }],
    details: { serializationKey: "message" },
    isError: false,
    timestamp: 2,
  };
  expect(committed.message).toEqual(expected);
  expect((await loadTranscriptEvents(target)).at(-1)).toMatchObject({ message: expected });
});

it("preserves tool text when JSON normalization copies a frozen content block", async () => {
  const { target, manager } = await fixture(state, "frozen-prepared-tool-text");
  await manager.appendMessageAsync(user("frozen-prepared-text"));
  const config = { logging: { redactPatterns: [String.raw`/opaque\(([^)]+)\)/g`] } };
  const block = Object.freeze({
    type: "text" as const,
    text: "opaque(abcdefghijklmnopqrst)",
    optional: undefined,
  });
  expect(block.text).toBe("opaque(abcdefghijklmnopqrst)");
  const committed = await manager.appendMessageWithTranscriptAnchorAsync(
    toolResult({
      toolCallId: "frozen-result",
      content: [block],
    }),
    { config },
  );
  const expected = [{ type: "text", text: "opaque(abcdefghijklmnopqrst)" }];
  expect(committed.message).toHaveProperty("content", expected);
  expect((await loadTranscriptEvents(target)).at(-1)).toMatchObject({
    message: { content: expected },
  });
});

it("preserves custom data toJSON keys and JSON value conversions in the committed view", async () => {
  const { target, manager } = await fixture(state, "custom-json-values");
  const id = await manager.appendCustomEntryAsync("json-values", {
    toJSON(key: string) {
      return {
        serializationKey: key,
        omitted: undefined,
        values: [undefined, Number.NaN, Number.POSITIVE_INFINITY],
        createdAt: new Date(0),
      };
    },
  });
  const expected = {
    serializationKey: "data",
    values: [null, null, null],
    createdAt: "1970-01-01T00:00:00.000Z",
  };
  expect(manager.getEntry(id)).toMatchObject({ type: "custom", data: expected });
  expect((await loadTranscriptEvents(target)).at(-1)).toMatchObject({
    type: "custom",
    data: expected,
  });
});

it("commits user and custom messages in FIFO order without host writes, and checks only fresh messages", async () => {
  const { target, manager } = await fixture(state, "async-messages");
  const database = openOpenClawAgentDatabase({ agentId: target.agentId, path: target.storePath });
  const hostExec = vi.spyOn(database.db, "exec");
  const beforeFreshMessageCommit = vi.fn(() => {
    expect(database.db.isTransaction).toBe(false);
  });
  try {
    const first = await manager.appendMessageWithTranscriptAnchorAsync(user("first"), {
      beforeFreshMessageCommit,
    });
    expect(first).toMatchObject({ appended: true, anchor: { entryId: first.entryId } });
    const replay = await manager.appendMessageWithTranscriptAnchorAsync(
      { ...user("first"), timestamp: 999 },
      { beforeFreshMessageCommit },
    );
    expect(replay).toMatchObject({
      appended: false,
      entryId: first.entryId,
      message: first.message,
    });
    expect(beforeFreshMessageCommit).toHaveBeenCalledTimes(1);
    const before = manager.getPersistedEntries();
    await expect(
      manager.appendMessageAsync(user("refused"), {
        beforeFreshMessageCommit: () => {
          throw new Error("Fresh message owner ended");
        },
      }),
    ).rejects.toThrow("Fresh message owner ended");
    expect(manager.getPersistedEntries()).toEqual(before);

    const custom = {
      role: "custom" as const,
      customType: "synthetic-notice",
      content: "Synthetic custom message",
      display: true,
      timestamp: 2,
    };
    const [customId, lastId] = await Promise.all([
      manager.appendMessageAsync(custom, { beforeFreshMessageCommit }),
      manager.appendMessageAsync(user("last"), { beforeFreshMessageCommit }),
    ]);
    expect(manager.getEntries()).toMatchObject([
      { id: first.entryId, parentId: null, message: user("first") },
      { id: customId, parentId: first.entryId, message: custom },
      { id: lastId, parentId: customId, message: user("last") },
    ]);
    expect(manager.getLeafId()).toBe(lastId);
    expect(beforeFreshMessageCommit).toHaveBeenCalledTimes(3);
    const beforeRejectedReplay = manager.getPersistedEntries();
    const refusedReplay = await manager.appendMessageAsync(user("first")).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refusedReplay).toMatchObject({
      name: "Error",
      message: `Session transcript keyed user is outside the current turn: ${first.entryId}`,
    });
    expect(isRecordedModelFallbackStop(refusedReplay)).toBe(false);
    expect(manager.getPersistedEntries()).toEqual(beforeRejectedReplay);
    const afterRefusal = await manager.appendMessageAsync(user("after-replay-refusal"));
    expect(manager.getLeafEntry()).toMatchObject({ id: afterRefusal, parentId: lastId });
    expect(hostExec.mock.calls.filter(([sql]) => /^BEGIN\b/iu.test(sql))).toEqual([]);
    expect(await loadTranscriptEvents(target)).toEqual(manager.getPersistedEntries());
  } finally {
    hostExec.mockRestore();
  }
});

it("revalidates overtaken keyed replays while retaining fresh committed pending users", async () => {
  const { target, manager } = await fixture(state, "overtaken-keyed-replay");
  const originalId = await manager.appendMessageAsync(user("original"));
  let newerId: string | undefined;
  const appendOvertaken = async (
    message: Parameters<SessionManager["appendMessageWithTranscriptAnchorAsync"]>[0],
    nextKey: string,
  ) => {
    const spy = afterMetadataReceipt(() => {
      // The retained synchronous SDK can publish before an awaited receipt is adopted.
      newerId = manager.appendMessage(user(nextKey));
    });
    try {
      return await manager.appendMessageWithTranscriptAnchorAsync(message);
    } finally {
      spy.mockRestore();
    }
  };
  const replayFailure = await appendOvertaken(user("original"), "after-replay").then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(replayFailure).toMatchObject({
    name: "Error",
    message: `Session transcript keyed user is outside the current turn: ${originalId}`,
  });
  expect(isRecordedModelFallbackStop(replayFailure)).toBe(false);
  expect(manager.getEntries()).toMatchObject([
    { id: originalId, parentId: null },
    { id: newerId, parentId: originalId },
  ]);
  expect(manager.getLeafId()).toBe(newerId);

  const pending = expectDefined(
    await stageSessionPendingInput(target, {
      runId: "fresh-pending",
      message: user("fresh-pending"),
      assertCurrent: () => {},
    }),
    "Expected fresh pending custody",
  );
  try {
    const committed = await pending.run(() => appendOvertaken(pending.message, "after-fresh"));
    expect(committed).toMatchObject({
      entryId: pending.inputId,
      message: pending.message,
      appended: true,
      viewWasSuperseded: true,
    });
    expect(pending.state).toBe("consumed");
    expect(manager.getLeafEntry()).toMatchObject({ id: newerId, parentId: pending.inputId });
    expect(manager[sessionManagerReadMessageAnchor](newerId)).toMatchObject({ entryId: newerId });
    expect(manager[sessionManagerReadMessageAnchor](committed.entryId)).toBeUndefined();
    expect(await loadTranscriptEvents(target)).toEqual(manager.getPersistedEntries());
  } finally {
    pending.finish("interrupted");
  }
});

it("fences local navigation changes at worker commit and receipt publication", async () => {
  const { target, manager } = await fixture(state, "navigation-during-append");
  const seed = expectDefined(
    await manager.appendMessageAsync(user("navigation-seed")),
    "Expected seed",
  );
  const tail = expectDefined(
    await manager.appendMessageAsync(user("navigation-tail")),
    "Expected tail",
  );
  const before = await loadTranscriptEvents(target);
  for (const change of ["branch", "branch-back"] as const) {
    manager.branch(tail);
    const admission = probe.admission(workerAdmission, (request, grant, admit) => {
      if (request.stage === "commit") {
        manager.branch(seed);
        if (change === "branch-back") {
          manager.branch(tail);
        }
      }
      admit(request, grant);
    });
    try {
      await expect(manager.appendMessageAsync(user(`refused-${change}`))).rejects.toThrow(
        "Session transcript navigation changed before publication",
      );
      expect(manager.getLeafId()).toBe(change === "branch" ? seed : tail);
      expect(await loadTranscriptEvents(target)).toEqual(before);
    } finally {
      admission.mockRestore();
    }
  }

  const publication = afterMetadataReceipt(() => manager.resetLeaf());
  let failure: unknown;
  try {
    failure = await manager.appendMessageAsync(user("committed-before-reset")).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({
      name: "SessionMessageCommittedError",
      cause: { message: "Session transcript navigation changed before publication" },
    });
    expect(isRecordedModelFallbackStop(failure)).toBe(true);
    expect(() => manager.getEntries()).toThrow("Session entry committed");
  } finally {
    publication.mockRestore();
  }
  const persisted = await loadTranscriptEvents(target);
  expect(persisted.slice(0, before.length)).toEqual(before);
  expect(persisted.slice(before.length)).toMatchObject([
    { type: "message", parentId: tail, message: user("committed-before-reset") },
  ]);
});

it("rolls back worker promotion when pending authority retires at commit", async () => {
  const { target, manager } = await fixture(state, "revoked-message");
  await manager.appendMessageAsync(user("seed"));
  let current = true;
  const receipt = expectDefined(
    await stageSessionPendingInput(target, {
      runId: "revoked",
      message: user("revoked"),
      assertCurrent: () => {
        if (!current) {
          throw new Error("Pending owner retired at commit");
        }
      },
    }),
    "Expected pending input custody",
  );
  const before = await loadTranscriptEvents(target);
  const admission = probe.admission(workerAdmission, (request, grant, admit) => {
    if (request.stage === "commit") {
      current = false;
    }
    admit(request, grant);
  });
  try {
    await expect(receipt.run(() => manager.appendMessageAsync(receipt.message))).rejects.toThrow(
      "Pending owner retired at commit",
    );
    expect(receipt.state).toBe("queued");
    expect(manager.getPersistedEntries()).toEqual(before);
  } finally {
    admission.mockRestore();
    current = true;
    receipt.finish("interrupted");
  }
  expect(await loadTranscriptEvents(target)).toEqual(before);
});

it.each([false, true])(
  "publishes appended invitations to retained membership (actor: %s)",
  async (retainActor) => {
    const name = `mention-invitation-${retainActor}`;
    const target = {
      agentId: "main",
      sessionId: name,
      sessionKey: `agent:main:${name}`,
      storePath: state.statePath(`${name}.sqlite`),
    };
    const createdActor = { type: "human", source: "profile", id: "alice" } as const;
    await upsertSessionEntryCore(target, { sessionId: name, updatedAt: 1, createdActor });
    await withSelectedTranscriptReader(
      target,
      async () => {
        const manager = await SessionManager.openAsync(target, state.workspaceDir);
        const before = await readSessionMembersInWorker(target);
        const retained = retainPreparedSessionSharingFacts({
          databaseIdentity: readDatabasePathIdentitySync(target.storePath).key,
          sessionKey: target.sessionKey,
          entry: before.entry,
          membership: new Set(before.members.map((member) => member.identityId)),
        });
        const acquiring = retainPreparedSessionSharingFacts({
          databaseIdentity: readDatabasePathIdentitySync(target.storePath).key,
          sessionKey: target.sessionKey,
          acquiring: true,
        });
        try {
          expect(retained.readCurrent()?.membership.has("bob")).toBe(false);
          const message = {
            ...user(name),
            content: "@bob please review",
            __openclaw: { humanMentions: [{ profileId: "bob", start: 0, end: 4 }] },
          };
          const mentionInvitation: SessionMentionInvitation = {
            addedBy: "alice",
            expectedEntry: {
              sessionId: name,
              createdActor,
              visibility: undefined,
              incognito: undefined,
            },
            profiles: [{ profileId: "bob", aliases: ["bob"], tokens: ["@bob"] }],
          };
          const recorder = createUserTurnTranscriptRecorder({
            target: { ...target, sessionEntry: before.entry },
            message,
            prepareMentionInvitation: () => ({
              invitation: mentionInvitation,
              assertCurrent: () => {},
            }),
          });
          attachRuntimeUserTurnTranscriptRecorder(message, recorder);
          const entryId = await withCurrentRuntimeUserTurnTranscriptRecorder(
            message,
            (beforeFreshMessageCommit) =>
              manager.appendMessageAsync(message, { beforeFreshMessageCommit }),
          );
          // A fresh read must not be what repairs the already retained authorization facts.
          expect(retained.readCurrent()?.membership.has("bob")).toBe(true);
          expect(
            acquiring
              .initialize({ entry: before.entry, membership: new Set() })
              .membership.has("bob"),
          ).toBe(true);
          expect((await readSessionMembersInWorker(target)).members).toEqual([
            expect.objectContaining({ identityId: "bob", addedBy: "alice" }),
          ]);
          expect(await loadTranscriptEvents(target)).toContainEqual(
            expect.objectContaining({ id: entryId, message }),
          );
        } finally {
          retained.release();
          acquiring.release();
        }
      },
      retainActor,
    );
  },
);

it("lets another session write between actor appends while retaining manager order", async () => {
  const target = {
    agentId: "main",
    sessionId: "append-owner",
    sessionKey: "agent:main:append-owner",
    storePath: state.statePath("transcript.sqlite"),
  };
  await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
  await withSelectedTranscriptReader(
    target,
    async () => {
      const manager = await SessionManager.openAsync(target);
      const entered = createDeferred();
      const release = createDeferred();
      const order: string[] = [];
      const batch = withSessionManagerAppend(manager, async () => {
        await manager.appendMessageAsync(makeUserMessage("first", 1));
        // Assembly and view adoption must permit storage resource cleanup and unrelated writes.
        assertOpenClawAgentWriterReleased("prepare the next session append");
        entered.resolve();
        await release.promise;
        await manager.appendMessageAsync(makeUserMessage("second", 2));
        order.push("batch");
      });
      let follower: Promise<unknown> | undefined;
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          batch,
          "Append batch settled before preparation",
        );
        follower = manager
          .appendMessageAsync(makeUserMessage("third", 3))
          .then(() => order.push("follower"));
        await upsertSessionEntryCore(
          { ...target, sessionKey: "agent:main:other" },
          { sessionId: "other", updatedAt: 1 },
        );
        expect(order).toEqual([]);
      } finally {
        release.resolve();
        await Promise.allSettled([batch, ...(follower ? [follower] : [])]);
      }
      await batch;
      await follower;
      expect(order).toEqual(["batch", "follower"]);
      const messages = manager.getEntries().filter((entry) => entry.type === "message");
      expect(messages.map((entry) => entry.message)).toMatchObject([
        { role: "user", content: "first" },
        { role: "user", content: "second" },
        { role: "user", content: "third" },
      ]);
      expect(messages[1]?.parentId).toBe(messages[0]?.id);
      expect(messages[2]?.parentId).toBe(messages[1]?.id);
    },
    true,
  );
});
