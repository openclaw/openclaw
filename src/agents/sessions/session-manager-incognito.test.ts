import assert from "node:assert/strict";
import { inspect } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { runWithCliHistoryWriter } from "../../config/sessions/cli-history-boundary.js";
import { persistCompactionBoundaryWithSessionEntryAsync } from "../../config/sessions/session-accessor.sqlite-compaction-runtime.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.sqlite-entry.js";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import {
  acquireSessionActorStorage,
  runWithSessionActorStorage,
  type SelectedSessionActorStorageBinding,
} from "../../config/sessions/session-actor-storage-binding.js";
import { withSessionTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import { applyLoggingConfig, resetLogger } from "../../logging/logger.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../../logging/secret-redaction-registry.test-support.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
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
async function captureCommitRevocation(
  target: SessionTranscriptRuntimeTarget,
  operation: (assertCurrent: () => void) => Promise<unknown>,
) {
  let current = true;
  const unsubscribe = sessionChanges.subscribeFacts((change) => {
    if ("sessionKey" in change && change.sessionKey === target.sessionKey) current = false;
  });
  try {
    await operation(() => {
      if (!current) throw new Error("Caller revoked after commit");
    });
  } catch (error) {
    return error;
  } finally {
    unsubscribe();
  }
  throw new Error("Expected committed operation to report revoked publication");
}

it("persists deduplicated messages, metadata, suffixes, rewrites, branches, and compaction on the memory owner", async () => {
  const { target } = await create("maintenance");
  const manager = await SessionManager.openAsync(target);
  const fresh = vi.fn();
  const original = { ...makeUserMessage("original", 1), idempotencyKey: "original:user" };
  const first = await manager.appendMessageWithTranscriptAnchorAsync(original, {
    beforeFreshMessageCommit: fresh,
  });
  expect(first).toMatchObject({ appended: true, anchor: { entryId: first.entryId } });
  expect(
    await manager.appendMessageWithTranscriptAnchorAsync(
      { ...original, timestamp: 2 },
      { beforeFreshMessageCommit: fresh },
    ),
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
    const { watermark } = await binding.actor.storage.read(
      { type: "session.history.watermark", input: {} },
      authority,
    );
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
    let current = true;
    const assertCurrent = () => {
      if (!current) throw new Error("CLI writer revoked");
    };
    await runWithCliHistoryWriter(
      {
        target,
        runId,
        authFingerprint,
        lifecycleRevision: "initial",
        assertCurrent,
        assertReadable: assertCurrent,
      },
      async () => {
        await manager.appendCustomEntryAsync("cli-metadata", { synthetic: true });
        const after = await binding.actor.storage.read(
          { type: "session.history.watermark", input: {} },
          authority,
        );
        expect(
          binding.actor.storage.readCurrent({ type: "session.entry.read", input: {} }, authority),
        ).toMatchObject({
          cliHistoryBoundary: { ...after.watermark, writerRunId: runId, authFingerprint },
        });
        expect(after.watermark.maxSeq).toBe((watermark.maxSeq ?? -1) + 1);
        current = false;
        await expect(manager.appendCustomEntryAsync("refused", {})).rejects.toThrow(
          "CLI writer revoked",
        );
        expect(
          (
            await binding.actor.storage.read(
              { type: "session.history.watermark", input: {} },
              authority,
            )
          ).watermark,
        ).toEqual(after.watermark);
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
  let current = true;
  const refused = withSessionManagerWriteAssertion(
    manager,
    () => {
      if (!current) throw new Error("writer revoked");
    },
    () => manager.appendCustomEntryAsync("refused"),
  );
  const rejected = expect(refused).rejects.toThrow("writer revoked");
  current = false;
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

it.each(["append", "persist"] as const)(
  "preserves acknowledged %s after caller revocation",
  async (method) => {
    const { target } = await create(`committed-${method}`);
    const manager = await SessionManager.openAsync(target);
    await manager.appendCustomEntryAsync("before-revocation");
    const failure = await captureCommitRevocation(target, (assertCurrent) =>
      withSessionManagerWriteAssertion(manager, assertCurrent, () =>
        method === "append"
          ? manager.appendCustomEntryAsync("committed-once")
          : manager.persistAsync({
              type: "custom",
              id: "committed-once",
              parentId: null,
              timestamp: new Date(1).toISOString(),
              customType: "committed-once",
              data: {},
            }),
      ),
    );
    expect(failure).toBeInstanceOf(Error);
    expect(isRecordedModelFallbackStop(failure)).toBe(true);
    expect(() => manager.getEntries()).toThrow();
    expect((await SessionManager.openAsync(target)).getEntries()).toMatchObject([
      { type: "custom", customType: "before-revocation" },
      { type: "custom", customType: "committed-once" },
    ]);
  },
);

it.each(["registry", "pattern"] as const)(
  "refuses static notes after %s redaction drift and accepts fresh preparation",
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
            if (policy === "registry") registerSecretValueForRedaction(marker);
            else patterns.push(marker);
          }
        },
      },
    };
    await expect(
      runWithSessionActorStorage(guarded, () => appendSessionTranscriptNote(target, note)),
    ).rejects.toThrow("Transcript message redaction changed before persistence");
    expect(changed).toBe(true);
    expect((await SessionManager.openAsync(target)).getEntries()).toEqual([]);
    const committed = await appendSessionTranscriptNote(target, note);
    const reopened = await SessionManager.openAsync(target);
    expect(reopened.getEntries()).toHaveLength(1);
    expect(reopened.getEntry(committed.messageId)).toMatchObject({ message: committed.message });
    expect(JSON.stringify(committed.message)).not.toContain(marker);
  },
);

it("retains the static-note receipt after acknowledged caller authority loss", async () => {
  const { target } = await create("static-receipt");
  const failure = await captureCommitRevocation(target, (assertCurrent) =>
    withSessionTranscriptWriteAssertion(target, assertCurrent, () =>
      appendSessionTranscriptNote(target, makeUserMessage("acknowledged note", 1), {
        config: { logging: { redactPatterns: [] } },
      }),
    ),
  );
  expect(failure).toBeInstanceOf(SessionTranscriptMessageCommittedError);
  assert(failure instanceof SessionTranscriptMessageCommittedError);
  expect(isRecordedModelFallbackStop(failure)).toBe(true);
  expect(failure.committedTarget).toMatchObject(target);
  expect(failure.committedVersion).toMatchObject({
    generation: expect.any(String),
    rawSeq: expect.any(Number),
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
  const failure = await captureCommitRevocation(target, (assertCurrent) =>
    withSessionManagerWriteAssertion(manager, assertCurrent, () =>
      rewrite.commit(new Map([[source, replacement]])),
    ),
  );
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
  const reject = (run: () => unknown, replacement: string) => {
    expect(run).toThrow(replacement);
    expect(manager.getEntries()).toEqual(before);
    expect(manager.getSessionTarget()).toEqual(beforeTarget);
    expect(manager.getLeafId()).toBe(id);
  };
  reject(() => manager.appendCustomEntry("forbidden", {}), "appendCustomEntryAsync");
  reject(() => manager.branch("missing"), "branchAsync");
  reject(() => manager.prepareTranscriptRewrite(), "prepareTranscriptRewriteAsync");
  reject(() => manager.removeTrailingEntries(() => true), "removeTrailingEntriesAsync");
  reject(() => manager.reloadPersistedTranscript(), "reloadPersistedTranscriptAsync");
  reject(() => manager.setSessionTarget(target), "setSessionTargetAsync");
  installSessionToolResultGuard(manager, { beforeMessageWriteHook: beforeWrite });
  reject(() => manager.appendMessage(makeUserMessage("forbidden", 2)), "appendMessageAsync");
  expect(beforeWrite).not.toHaveBeenCalled();
  const read = vi.fn();
  reject(() => SessionManager.open(target), "openAsync");
  reject(
    () => SessionManager.openBounded(target, { maxEvents: 2, maxBytes: 8192 }),
    "openBoundedAsync",
  );
  reject(
    () => SessionManager.openDetachedBounded(target, { maxEvents: 2, maxBytes: 8192 }),
    "openDetachedBoundedAsync",
  );
  reject(() => SessionManager.openModelContext(target), "openModelContextAsync");
  reject(() => SessionManager.readSessionContext(target, read), "readSessionContextAsync");
  reject(
    () => SessionManager.appendMessageToTranscript(target, makeUserMessage("forbidden", 2)),
    "appendMessageToTranscriptAsync",
  );
  expect(read).not.toHaveBeenCalled();
  await manager.appendCustomEntryAsync("still writable", {});
});
