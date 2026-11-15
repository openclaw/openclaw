import assert from "node:assert/strict";
import { inspect } from "node:util";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { runWithCliHistoryWriter } from "../../config/sessions/cli-history-boundary.js";
import { persistCompactionBoundaryWithSessionEntryAsync } from "../../config/sessions/session-accessor.sqlite-compaction-runtime.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.sqlite-entry.js";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import { acquireSessionActorStorage } from "../../config/sessions/session-actor-storage-acquisition.js";
import {
  runWithSessionActorStorage,
  type SelectedSessionActorStorageBinding,
} from "../../config/sessions/session-actor-storage-binding.js";
import { withSessionTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import { applyLoggingConfig, resetLogger } from "../../logging/logger.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../../logging/secret-redaction-registry.test-support.js";
import {
  readSessionTranscriptVisibleMessageDelta,
  readVisibleSessionTranscriptMessageEntries,
} from "../../plugin-sdk/session-transcript-runtime.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { rewriteTranscriptEntriesInSessionManager } from "../embedded-agent-runner/transcript-rewrite.js";
import { isRecordedModelFallbackStop } from "../model-fallback-stop.js";
import { installSessionToolResultGuard } from "../session-tool-result-guard.js";
import { withSessionCompactionPersistenceAsync } from "./session-compaction-persistence.js";
import { SessionTranscriptMessageCommittedError } from "./session-manager-message-error.js";
import {
  appendSessionTranscriptNote,
  withSessionManagerWrite,
  withSessionManagerWriteAssertion,
} from "./session-manager-write-admission.js";
import { SessionManager } from "./session-manager.js";

const authority = { assertCurrent() {}, authorize() {} };
const bindings: SelectedSessionActorStorageBinding[] = [];
function revocable(message: string) {
  const controller = new AbortController();
  return {
    revoke: () => controller.abort(new Error(message)),
    assertCurrent: () => controller.signal.throwIfAborted(),
  };
}
afterEach(async () => {
  for (const binding of bindings.splice(0)) {
    await binding.actor.release();
    memorySessionActorOwners.closeDatabase(binding);
  }
  resetSecretRedactionRegistryForTest();
  resetLogger();
});
async function create(name: string) {
  const env = { OPENCLAW_STATE_DIR: `/synthetic/session-manager-contract/${name}` };
  const target = {
    agentId: "main",
    env,
    sessionKey: `agent:main:dashboard:incognito-${name}`,
    sessionId: name,
    storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
  };
  const binding = await acquireSessionActorStorage(target, {
    authority,
    lifetime: { assertCurrent() {}, assertReadable() {} },
    create: true,
  });
  assert(binding);
  bindings.push(binding);
  expect(
    await binding.actor.storage.mutate(
      {
        type: "session.entry.create",
        input: {
          entry: { sessionId: name, lifecycleRevision: "initial", updatedAt: 1 },
          cwd: "/synthetic",
        },
      },
      authority,
    ),
  ).toMatchObject({ kind: "committed" });
  return { target, binding, run: <T>(run: () => T) => runWithSessionActorStorage(binding, run) };
}
async function withCommitRevocation(
  target: SessionTranscriptRuntimeTarget,
  operation: (assertCurrent: () => void) => Promise<unknown>,
) {
  const caller = revocable("Caller revoked after commit");
  const unsubscribe = sessionChanges.subscribeFacts((change) => {
    if ("sessionKey" in change && change.sessionKey === target.sessionKey) {
      caller.revoke();
    }
  });
  try {
    await operation(caller.assertCurrent);
  } finally {
    unsubscribe();
  }
}

function readWatermark(binding: SelectedSessionActorStorageBinding) {
  return binding.actor.storage.read({ type: "session.history.watermark", input: {} }, authority);
}

it("persists deduplicated messages, metadata, suffixes, rewrites, branches, and compaction on the memory owner", async () => {
  const { target } = await create("maintenance");
  const manager = await SessionManager.openAsync(target);
  const fresh = vi.fn();
  const grant = { beforeFreshMessageCommit: fresh };
  const original = { ...makeUserMessage("original", 1), idempotencyKey: "original:user" };
  const first = await manager.appendMessageWithTranscriptAnchorAsync(original, grant);
  expect(first).toMatchObject({ appended: true, anchor: { entryId: first.entryId } });
  expect(
    await manager.appendMessageWithTranscriptAnchorAsync({ ...original, timestamp: 2 }, grant),
  ).toMatchObject({ appended: false, entryId: first.entryId });
  expect(fresh).toHaveBeenCalledTimes(1);
  await manager.appendLeafControlAsync({ targetId: first.entryId, appendParentId: first.entryId });
  await manager.appendModelChange("synthetic", "model");
  await manager.appendThinkingLevelChange("high");
  const temporary = await manager.appendCustomEntryAsync("temporary", { exact: "payload" });
  expect(await manager.removeTrailingEntriesAsync((entry) => entry.id === temporary)).toBe(1);
  const rewrite = await manager.prepareTranscriptRewriteAsync();
  await rewrite.sessionManager.resetLeafAsync();
  const replacement = await rewrite.sessionManager.appendMessageAsync(
    makeUserMessage("replacement", 3),
  );
  assert(replacement);
  await rewrite.commit(new Map([[first.entryId, replacement]]));
  expect(manager.getLeafId()).toBe(replacement);
  const branchedId = await manager.createBranchedSession(replacement);
  expect(branchedId).toBe(manager.getSessionId());
  const currentTarget = manager.getSessionTarget()!;
  await withSessionCompactionPersistenceAsync(
    manager,
    (prepared) =>
      persistCompactionBoundaryWithSessionEntryAsync(currentTarget, {
        prepared,
        transcriptByteCompactionLatch: {
          activeBytes: 2048,
          sessionId: currentTarget.sessionId,
          maxBytes: 1024,
        },
      }),
    () => manager.appendCompactionAsync("summary", replacement, 100),
  );
  expect(
    memorySessionActorOwners
      .read({ agentId: target.agentId, path: target.storePath })
      ?.readSession(target.sessionKey, authority)?.entry,
  ).toMatchObject({ sessionId: branchedId, compactionCount: 1 });
  expect((await SessionManager.openAsync(currentTarget)).getBranch()).toEqual(manager.getBranch());
});

it("advances the CLI writer boundary through metadata commits and refuses revoked writers", async () => {
  const { target, binding, run } = await create("cli-metadata");
  await run(async () => {
    const manager = await SessionManager.openAsync(target);
    const { watermark } = await readWatermark(binding);
    const runId = "synthetic-cli-run";
    const authFingerprint = "a".repeat(64);
    await patchSessionEntryCore(target, () => ({
      activeWriterRunId: runId,
      cliHistoryBoundary: {
        version: 1,
        sessionId: target.sessionId,
        state: "known",
        ...watermark,
        authFingerprint,
        writerRunId: runId,
      },
    }));
    const caller = revocable("CLI writer revoked");
    await runWithCliHistoryWriter(
      {
        target,
        runId,
        authFingerprint,
        lifecycleRevision: "initial",
        assertCurrent: caller.assertCurrent,
        assertReadable: caller.assertCurrent,
      },
      async () => {
        await manager.appendCustomEntryAsync("cli-metadata", { synthetic: true });
        const after = await readWatermark(binding);
        expect(
          binding.actor.storage.readCurrent({ type: "session.entry.read", input: {} }, authority),
        ).toMatchObject({
          cliHistoryBoundary: { ...after.watermark, writerRunId: runId, authFingerprint },
        });
        expect(after.watermark.maxSeq).toBe((watermark.maxSeq ?? -1) + 1);
        caller.revoke();
        await expect(manager.appendCustomEntryAsync("refused", {})).rejects.toThrow(
          "CLI writer revoked",
        );
        expect((await readWatermark(binding)).watermark).toEqual(after.watermark);
      },
    );
  });
});

it("rolls back fresh-message refusal and checks queued caller authority before mutation", async () => {
  const { target } = await create("authority");
  const manager = await SessionManager.openAsync(target);
  await expect(
    manager.appendMessageAsync(makeUserMessage("refused", 1), {
      beforeFreshMessageCommit() {
        throw new Error("fresh grant revoked");
      },
    }),
  ).rejects.toThrow("fresh grant revoked");
  expect((await SessionManager.openAsync(target)).getEntries()).toEqual([]);
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const held = withSessionManagerWrite(manager, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const caller = revocable("writer revoked");
  const refused = withSessionManagerWriteAssertion(manager, caller.assertCurrent, () =>
    manager.appendCustomEntryAsync("refused"),
  );
  const rejected = expect(refused).rejects.toThrow("writer revoked");
  caller.revoke();
  release.resolve();
  await Promise.all([held, rejected]);
  const [one, two] = await Promise.all([
    manager.appendCustomEntryAsync("one"),
    manager.appendCustomEntryAsync("two"),
  ]);
  expect(manager.getEntries()).toMatchObject([
    { id: one, parentId: null },
    { id: two, parentId: one },
  ]);
  expect((await SessionManager.openAsync(target)).getEntries()).toEqual(manager.getEntries());
});

it.each(["append", "persist"] as const)("keeps committed %s after revocation", async (method) => {
  const { target } = await create(`committed-${method}`);
  const manager = await SessionManager.openAsync(target);
  await manager.appendCustomEntryAsync("before-revocation");
  await withCommitRevocation(target, (assertCurrent) =>
    withSessionManagerWriteAssertion(manager, assertCurrent, async () => {
      if (method === "append") {
        await manager.appendCustomEntryAsync("committed-once");
      } else {
        await manager.persistAsync({
          type: "custom",
          id: "committed-once",
          parentId: null,
          timestamp: new Date(1).toISOString(),
          customType: "committed-once",
          data: {},
        });
      }
      expect(assertCurrent).toThrow("Caller revoked after commit");
      await expect(manager.appendCustomEntryAsync("refused")).rejects.toThrow(
        "Caller revoked after commit",
      );
    }),
  );
  if (method === "persist") {
    await manager.reloadPersistedTranscriptAsync();
  }
  expect(manager.getEntries()).toMatchObject([
    { type: "custom", customType: "before-revocation" },
    { type: "custom", customType: "committed-once" },
  ]);
  expect((await SessionManager.openAsync(target)).getEntries()).toEqual(manager.getEntries());
});

it.each(["registry", "pattern"] as const)(
  "keeps notes through %s redaction changes",
  async (policy) => {
    const { target, binding } = await create(`redaction-${policy}`);
    const marker = `synthetic-note-${policy}-private-value`;
    const note = {
      role: "custom" as const,
      customType: "fixture:note",
      content: `Visible ${marker} end`,
      display: true,
      timestamp: 1,
    };
    const patterns: string[] = [];
    applyLoggingConfig({ redactPatterns: patterns });
    let changed = false;
    const guarded = {
      ...binding,
      authority: {
        assertCurrent() {},
        authorize(stage: "transaction" | "commit") {
          if (stage === "commit" && !changed) {
            changed = true;
            if (policy === "registry") {
              registerSecretValueForRedaction(marker);
            } else {
              patterns.push(marker);
            }
          }
        },
      },
    };
    const committed = await runWithSessionActorStorage(guarded, () =>
      appendSessionTranscriptNote(target, note),
    );
    expect(changed).toBe(true);
    const reopened = await SessionManager.openAsync(target);
    expect(reopened.getEntries()).toHaveLength(1);
    expect(reopened.getEntry(committed.messageId)).toMatchObject({ message: committed.message });
    expect(committed.message).toEqual(note);
  },
);

it("retains the static-note receipt after acknowledged caller authority loss", async () => {
  const { target } = await create("static-receipt");
  const failure = await withCommitRevocation(target, (assertCurrent) =>
    withSessionTranscriptWriteAssertion(target, assertCurrent, () =>
      appendSessionTranscriptNote(target, makeUserMessage("acknowledged note", 1), {
        config: { logging: { redactPatterns: [] } },
      }),
    ),
  ).catch((error: unknown) => error);
  assert(failure instanceof SessionTranscriptMessageCommittedError);
  expect(isRecordedModelFallbackStop(failure)).toBe(true);
  expect(failure).toMatchObject({
    committedTarget: target,
    committedVersion: { generation: expect.any(String), rawSeq: expect.any(Number) },
  });
  expect((await SessionManager.openAsync(target)).getEntries()).toMatchObject([
    { id: failure.committedMessageId, type: "message" },
  ]);
});

it("keeps acknowledged rewrite payloads out of error diagnostics", async () => {
  const { target } = await create("private-rewrite");
  const manager = await SessionManager.openAsync(target);
  const source = await manager.appendMessageAsync(makeUserMessage("original", 1));
  const rewrite = await manager.prepareTranscriptRewriteAsync();
  await rewrite.sessionManager.resetLeafAsync();
  const marker = "synthetic-incognito-private-receipt-content";
  const replacement = await rewrite.sessionManager.appendMessageAsync(makeUserMessage(marker, 2));
  assert(source && replacement);
  const failure = await withCommitRevocation(target, (assertCurrent) =>
    withSessionManagerWriteAssertion(manager, assertCurrent, () =>
      rewrite.commit(new Map([[source, replacement]])),
    ),
  ).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(inspect(failure, { depth: null })).not.toContain(marker);
  expect(() => manager.getEntries()).toThrow();
  expect((await SessionManager.openAsync(target)).getEntries()).toMatchObject([
    { id: source, message: { content: "original" } },
    { id: replacement, message: { content: marker } },
  ]);
});

it("refuses synchronous SDK writes before view mutation or tool-result hooks", async () => {
  const { target } = await create("sync-preflight");
  const manager = await SessionManager.openAsync(target);
  const id = await manager.appendMessageAsync(makeUserMessage("unchanged", 1));
  const before = structuredClone(manager.getEntries());
  const beforeTarget = manager.getSessionTarget();
  const beforeWrite = vi.fn();
  const read = vi.fn();
  const bounds = { maxEvents: 2, maxBytes: 8192 };
  for (const [method, run] of Object.entries({
    appendCustomEntry: () => manager.appendCustomEntry("forbidden", {}),
    branch: () => manager.branch("missing"),
    prepareTranscriptRewrite: () => manager.prepareTranscriptRewrite(),
    removeTrailingEntries: () => manager.removeTrailingEntries(() => true),
    reloadPersistedTranscript: () => manager.reloadPersistedTranscript(),
    setSessionTarget: () => manager.setSessionTarget(target),
    appendMessage: () => manager.appendMessage(makeUserMessage("forbidden", 2)),
    open: () => SessionManager.open(target),
    openBounded: () => SessionManager.openBounded(target, bounds),
    openDetachedBounded: () => SessionManager.openDetachedBounded(target, bounds),
    openModelContext: () => SessionManager.openModelContext(target),
    readSessionContext: () => SessionManager.readSessionContext(target, read),
    appendMessageToTranscript: () =>
      SessionManager.appendMessageToTranscript(target, makeUserMessage("forbidden", 2)),
  })) {
    if (method === "appendMessage") {
      installSessionToolResultGuard(manager, { beforeMessageWriteHook: beforeWrite });
    }
    expect(run).toThrow(`${method}Async`);
    expect(manager.getEntries()).toEqual(before);
    expect(manager.getSessionTarget()).toEqual(beforeTarget);
    expect(manager.getLeafId()).toBe(id);
  }
  expect(beforeWrite).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  await manager.appendCustomEntryAsync("still writable", {});
});

type DeltaParams = Parameters<typeof readSessionTranscriptVisibleMessageDelta>[0];
// Drains every visible-delta page the way a context engine would.
async function drainVisible(params: DeltaParams) {
  const ids: string[] = [];
  let cursor = params.cursor;
  for (;;) {
    const next = await readSessionTranscriptVisibleMessageDelta({ ...params, cursor });
    if (next.kind !== "page") {
      return { ids, cursor, reset: next.kind === "reset" ? next.reason : next.kind };
    }
    ids.push(...next.entries.map((entry) => entry.entryId));
    cursor = next.cursor;
    if (!next.hasMore) {
      return { ids, cursor };
    }
  }
}
const toolCall = {
  role: "assistant",
  content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
  stopReason: "toolUse",
  timestamp: 2,
};
const toolResult = (toolCallId: string, text: string) => ({
  role: "toolResult",
  toolCallId,
  toolName: "read",
  content: [{ type: "text", text }],
  isError: false,
  timestamp: 3,
});
const answer = (text: string, timestamp: number) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  timestamp,
});

it("drains incognito reset windows with retained tool pairs and reports later resets", async () => {
  const { target } = await create("reset-window");
  const manager = await SessionManager.openAsync(target);
  const append = async (message: unknown) =>
    expectDefined(
      await manager.appendMessageAsync(message as Parameters<SessionManager["appendMessage"]>[0]),
      "appended entry id",
    );
  const oldUser = await append(makeUserMessage("old question", 1));
  const oldAnswer = await append(answer("old answer", 1));
  const kept = await append(makeUserMessage("read the file", 2));
  const call = await append(toolCall);
  const paired = await append(toolResult("call_1", "paired"));
  const orphan = await append(toolResult("orphan-call", "orphan"));
  const summary = await append(answer("summary", 4));
  await manager.appendResetBoundaryAsync("idle", kept);
  const current = await append(makeUserMessage("current question", 5));

  // The default start is unchanged and still includes pre-reset history.
  await expect(drainVisible({ ...target, maxMessages: 3 })).resolves.toMatchObject({
    ids: [oldUser, oldAnswer, kept, call, paired, orphan, summary, current],
  });
  // The retained tail keeps the paired tool result and drops the orphan.
  const windowed = await drainVisible({ ...target, maxMessages: 2, start: "reset-window" });
  expect(windowed.ids).toEqual([kept, call, paired, summary, current]);

  await manager.appendResetBoundaryAsync("reset");
  const fresh = await append(makeUserMessage("fresh question", 6));
  await expect(
    drainVisible({ ...target, cursor: windowed.cursor, start: "reset-window" }),
  ).resolves.toMatchObject({ ids: [], reset: "session_reset" });
  await expect(drainVisible({ ...target, start: "reset-window" })).resolves.toMatchObject({
    ids: [fresh],
  });
});

it("records the replaced entry id on repeated incognito rewrites", async () => {
  const { target } = await create("rewrite-markers");
  const manager = await SessionManager.openAsync(target);
  const ids: string[] = [];
  for (const message of [
    makeUserMessage("read file", 1),
    toolCall,
    toolResult("call_1", "large original result"),
    answer("summary", 4),
  ]) {
    ids.push(
      expectDefined(
        await manager.appendMessageAsync(message as Parameters<SessionManager["appendMessage"]>[0]),
        "appended entry id",
      ),
    );
  }
  const [userId, callId, toolId, tailId] = ids;
  const markers = async () => {
    const visible = await readVisibleSessionTranscriptMessageEntries(target);
    const delta = await drainVisible(target);
    // Both plugin read paths project the same marker.
    expect(delta.ids).toEqual(visible.map((entry) => entry.entryId));
    return visible.map((entry) => [entry.entryId, entry.supersedesEntryId]);
  };
  const rewriteTool = async (sessionManager: SessionManager, entryId: string, text: string) => {
    await rewriteTranscriptEntriesInSessionManager({
      sessionManager,
      replacements: [{ entryId, message: toolResult("call_1", text) as never }],
    });
    return sessionManager
      .getBranch()
      .slice(2)
      .map((entry) => entry.id);
  };
  const [toolCopy, tailCopy] = await rewriteTool(
    manager,
    expectDefined(toolId, "tool id"),
    "short",
  );
  await expect(markers()).resolves.toEqual([
    [userId, undefined],
    [callId, undefined],
    [toolCopy, toolId],
    [tailCopy, tailId],
  ]);

  // A reopened view matches its committed rows, so a later rewrite chains from the copy.
  const reopened = await SessionManager.openAsync(target);
  const [toolSecond, tailSecond] = await rewriteTool(
    reopened,
    expectDefined(toolCopy, "copy id"),
    "shorter",
  );
  await expect(markers()).resolves.toEqual([
    [userId, undefined],
    [callId, undefined],
    [toolSecond, toolCopy],
    [tailSecond, tailCopy],
  ]);
});
