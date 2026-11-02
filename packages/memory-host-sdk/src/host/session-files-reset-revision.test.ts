import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { captureRuntimeConfigAsyncReader } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  patchSessionEntryCore,
  persistSessionTranscriptTurn,
  readActiveTranscriptEntryAnchor,
  readTranscriptStatsSync,
  resetSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "../../../../src/config/sessions/session-accessor.js";
import { replaceTranscriptEventsSync as replaceEvents } from "../../../../src/config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { memorySessionActorOwners } from "../../../../src/config/sessions/session-actor-memory-owner.js";
import { runWithSessionTranscriptReadFence as withReadFence } from "../../../../src/config/sessions/session-transcript-read-fence.js";
import { registerSecretValueForRedaction } from "../../../../src/logging/secret-redaction-registry.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../../../src/state/openclaw-agent-db.paths.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../../src/test-utils/openclaw-test-state.js";
import {
  buildSessionEntry,
  buildSessionEntries,
  matchesSessionEntryPrefixHash,
  type BuildSessionEntryOptions,
  type SessionFileEntry,
} from "./session-files.js";
import { readSessionResetRecallCutoff as readCutoff } from "./session-reset-recall-read.js";
import { readSessionResetRecallCutoffInProcess as readCutoffInline } from "./session-reset-recall-read.worker.js";

function requireSessionEntry(entry: SessionFileEntry | null): SessionFileEntry {
  assert(entry, "expected session entry");
  return entry;
}

let tmpDir: string;
let state: OpenClawTestState;

const sessionScope = (sessionId: string, sessionKey = `agent:main:chat:${sessionId}`) => ({
  agentId: "main",
  sessionId,
  sessionKey,
  storePath: path.join(tmpDir, "agents", "main", "sessions", "sessions.json"),
});
const messageEvent = (id: string, role: string, content: unknown, parentId?: string | null) => ({
  type: "message",
  id,
  message: { role, content },
  ...(parentId !== undefined ? { parentId } : {}),
});
const msg = (role: string, content: unknown, metadata?: Record<string, unknown>) => ({
  role,
  content,
  ...metadata,
});
const internalMessage = (content: string, sourceTool: string) =>
  msg("user", content, { provenance: { kind: "internal_system", sourceTool } });
const cutoffSymbol = Symbol.for("openclaw.memory.sessionResetRecallCutoff");
const cutoffDescriptor = (entry: SessionFileEntry) =>
  Object.getOwnPropertyDescriptor(entry, cutoffSymbol);
const persist = (scope: ReturnType<typeof sessionScope>, role: string, content: string) =>
  persistSessionTranscriptTurn(scope, {
    messages: [{ message: { role, content } }],
    touchSessionEntry: true,
    updateMode: "none",
  });
const append = (
  scope: ReturnType<typeof sessionScope>,
  eventId: string,
  message: Parameters<typeof appendTranscriptMessage>[1]["message"],
) => appendTranscriptMessage(scope, { eventId, message });
const exportEntry = async (
  scope: ReturnType<typeof sessionScope>,
  options: BuildSessionEntryOptions = {},
) => requireSessionEntry(await buildSessionEntry(scope.sessionKey, { ...scope, ...options }));

beforeEach(async () => {
  state = await createOpenClawTestState({ prefix: "session-revision-test-", layout: "state-only" });
  tmpDir = state.stateDir;
});
afterEach(async () => {
  await state.cleanup();
});

describe("SQLite session snapshots and reset content revision", () => {
  it("keeps batched incremental exports current across sessions, appends and rewrites", async () => {
    const scope = sessionScope("incremental");
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const sibling = sessionScope("sibling");
    await upsertSessionEntryCore(sibling, { sessionId: sibling.sessionId, updatedAt: 1 });
    await append(sibling, "sibling-question", msg("user", "Sibling preference."));
    const first = {
      type: "message",
      id: "heartbeat",
      message: internalMessage("Poll.", "heartbeat"),
    };
    expect(replaceEvents(scope, [first])).toBe(true);
    const fullExport = () =>
      buildSessionEntry(scope.sessionKey, { ...scope, onTranscriptMessage() {} });
    let expectedSibling = "User: Sibling preference.";
    const workerExport = async () => {
      const [entry, siblingEntry] = await buildSessionEntries([
        { absPath: scope.sessionKey, options: scope },
        { absPath: sibling.sessionKey, options: sibling },
      ]);
      expect(siblingEntry?.content).toBe(expectedSibling);
      expect(siblingEntry).toEqual(
        await buildSessionEntry(sibling.sessionKey, { ...sibling, onTranscriptMessage() {} }),
      );
      return entry ?? null;
    };
    expect(await workerExport()).toEqual(await fullExport());

    await append(scope, "heartbeat-answer", msg("assistant", "Heartbeat reply."));
    await append(
      scope,
      "question",
      msg("user", "New preference.", { __openclaw: { senderIsOwner: true } }),
    );
    const appended = requireSessionEntry(await workerExport());
    expect(appended).toEqual(await fullExport());
    expect(appended).toMatchObject({ content: "User: New preference.", lineMap: [3] });
    expect(appended.lineProvenance[0]?.originClass).toBe("owner");
    expect(await workerExport()).toEqual(appended);

    await append(sibling, "sibling-answer", msg("assistant", "Sibling reply."));
    expectedSibling += "\nAssistant: Sibling reply.";

    expect(
      replaceEvents(scope, [{ ...first, message: msg("user", "Rewritten preference.") }]),
    ).toBe(true);
    const rewritten = requireSessionEntry(await workerExport());
    expect(rewritten).toEqual(await fullExport());
    expect(rewritten).toMatchObject({
      content: "User: Rewritten preference.",
      lineMap: [1],
    });
  });

  it.each(["interactive", "dreaming", "cron"])(
    "preserves SQLite/archive output and callback observations for %s transcripts",
    async (kind) => {
      const scope = sessionScope("parity");
      const observedAt = Date.parse("2026-07-01T10:00:00.000Z");
      const payload = "x".repeat(64_000);
      const thought = { type: "thinking", thinking: payload };
      const messages = [
        msg("user", "Owner.", { __openclaw: { senderIsOwner: true } }),
        msg("assistant", "Derived.", { __openclaw: { turnTainted: true } }),
        internalMessage("Poll.", "heartbeat"),
        { role: "toolResult", content: "Tool result.", details: payload },
        msg("assistant", [
          {
            type: "toolCall",
            name: "write",
            arguments: { path: "MEMORY.md", content: "Note." },
          },
        ]),
        msg("assistant", "Heartbeat output."),
        internalMessage("Recall.", "memory_get"),
        msg("assistant", "Recall output."),
        msg("user", [{ type: "image", source: "photo.jpg" }], {
          __openclaw: { senderIsOwner: true },
        }),
        msg("assistant", [{ type: "text", text: "Photo." }]),
        msg("assistant", [thought, { type: "text", text: "" }], {
          timestamp: 1000,
          providerReplay: { payload },
        }),
      ];
      const records = [
        { type: "custom", customType: "metadata", data: {} },
        ...messages.map((message, index) => ({
          type: "message",
          id: `message-${index}`,
          timestamp: "2026-07-01T10:00:00.000Z",
          message,
        })),
      ];
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: observedAt });
      expect(replaceEvents(scope, records)).toBe(true);
      const archivePath = path.join(tmpDir, "parity.jsonl.deleted.2026-07-01T10-00-00.000Z");
      fsSync.writeFileSync(archivePath, records.map((record) => JSON.stringify(record)).join("\n"));
      fsSync.utimesSync(archivePath, observedAt / 1000, observedAt / 1000);
      const options = {
        generatedByCronRun: kind === "cron",
        generatedByDreamingNarrative: kind === "dreaming",
        sessionKind: "interactive" as const,
      };
      const sqliteObserver = vi.fn();
      const archiveObserver = vi.fn();
      const sqlite = await exportEntry(scope, {
        ...options,
        updatedAtMs: observedAt,
        onTranscriptMessage: sqliteObserver,
      });
      const archive = requireSessionEntry(
        await buildSessionEntry(archivePath, {
          ...options,
          onTranscriptMessage: archiveObserver,
        }),
      );
      const worker = await exportEntry(scope, {
        ...options,
        updatedAtMs: observedAt,
      });

      expect(sqlite).toEqual({
        ...archive,
        absPath: scope.sessionKey,
        path: "sessions/main/parity.jsonl",
        revisionMs: readTranscriptStatsSync(scope).lastMutationAtMs,
      });
      expect(sqlite).toMatchObject({
        content:
          kind === "interactive" ? "User: Owner.\nAssistant: Derived.\nAssistant: Photo." : "",
        lineMap: kind === "interactive" ? [2, 3, 11] : [],
        messageTimestampsMs: kind === "interactive" ? [observedAt, observedAt, observedAt] : [],
      });
      expect(sqlite.lineProvenance.map((line) => line.originClass)).toEqual(
        kind === "interactive" ? ["owner", "untrusted", "agent"] : [],
      );
      const observations = messages
        .filter((message) => message.role !== "toolResult")
        .map((message) => [message, "timestamp" in message ? 1_000_000 : observedAt]);
      expect(sqliteObserver.mock.calls).toEqual(observations);
      expect(archiveObserver.mock.calls).toEqual(observations);
      expect(worker).toEqual(sqlite);
      expect(cutoffDescriptor(worker)).toEqual(cutoffDescriptor(sqlite));
      expect(cutoffDescriptor(sqlite)).toEqual(cutoffDescriptor(archive));
    },
  );

  it("preserves registered secrets in worker and inline exports", async () => {
    const scope = sessionScope("secret");
    const content = "API_TOKEN = computeToken() sk-abc123456789012345678";
    registerSecretValueForRedaction(content);
    const sessionEntry = { sessionId: scope.sessionId, updatedAt: 1 };
    await patchSessionEntryCore(scope, () => sessionEntry, {
      fallbackEntry: sessionEntry,
      skipMaintenance: true,
    });
    expect(replaceEvents(scope, [messageEvent("source-text", "user", content)])).toBe(true);
    const worker = await exportEntry(scope);
    const inline = await exportEntry(scope, { parseYieldEveryLines: 1 });
    expect(worker.content).toBe(`User: ${content}`);
    expect(inline.content).toBe(worker.content);
    expect(inline.hash).toBe(worker.hash);
  });

  it.each([false, true])(
    "keeps missing and incognito exports non-persisting (incognito=%s)",
    async (incognito) => {
      const scope = {
        ...sessionScope(
          "missing",
          incognito ? "agent:main:dashboard:incognito-export" : "agent:main:chat:missing",
        ),
        storePath: path.join(tmpDir, "agents", "main", "agent", "openclaw-agent.sqlite"),
      };
      expect(await buildSessionEntry(scope.sessionKey, scope)).toBeNull();
      expect(await buildSessionEntries([{ absPath: scope.sessionKey, options: scope }])).toEqual([
        null,
      ]);
      expect(await readCutoff(scope)).toEqual({ state: "invalid" });
      expect(fsSync.existsSync(scope.storePath)).toBe(false);
      await upsertSessionEntryCore(scope, {
        sessionId: scope.sessionId,
        updatedAt: 1,
        ...(incognito ? { incognito: true } : {}),
      });
      await append(scope, "visible", msg("user", "Visible transcript"));
      expect((await buildSessionEntry(scope.sessionKey, scope))?.content).toBe(
        "User: Visible transcript",
      );
      const [batched] = await buildSessionEntries([{ absPath: scope.sessionKey, options: scope }]);
      expect(batched?.content).toBe("User: Visible transcript");
      expect(await readCutoff(scope)).toEqual({ state: "absent" });
      expect(fsSync.existsSync(scope.storePath)).toBe(!incognito);
      if (incognito) {
        const namespace = {
          agentId: scope.agentId,
          path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: scope.agentId }),
        };
        memorySessionActorOwners.closeDatabase(namespace);
        expect(
          await buildSessionEntries([
            { absPath: scope.sessionKey, options: scope },
            {
              absPath: scope.sessionKey,
              options: { ...scope, sessionKey: undefined, storePath: namespace.path },
            },
          ]),
        ).toEqual([null, null]);
        expect(memorySessionActorOwners.read(namespace)).toBeUndefined();
        expect(fsSync.existsSync(namespace.path)).toBe(false);
        expect(fsSync.existsSync(scope.storePath)).toBe(false);
      }
    },
  );

  it("finishes the transcript snapshot before callbacks can replace its rows", async () => {
    const scope = sessionScope("snapshot", "agent:main:snapshot");
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const first = messageEvent("first", "user", "first", null);
    const kept = messageEvent("kept", "assistant", "kept", "first");
    const records = [
      first,
      messageEvent("tool-result", "toolResult", "payload-only-probe".repeat(4096)),
      kept,
      { type: "reset", id: "reset", parentId: "kept", firstKeptEntryId: "kept" },
    ];
    expect(replaceEvents(scope, records)).toBe(true);
    const before = await exportEntry(scope);
    expect(await readCutoff(scope)).toEqual({ state: "valid", cutoffLine: 3 });
    const parse = JSON.parse;
    const payloadGuard = vi.spyOn(JSON, "parse").mockImplementation((...args) => {
      if (args[0].includes("payload-only-probe")) {
        throw new Error("Reset metadata must not hydrate message payloads");
      }
      return Reflect.apply(parse, JSON, args);
    });
    try {
      expect(readCutoffInline(scope)).toEqual({
        state: "valid",
        cutoffLine: 3,
      });
    } finally {
      payloadGuard.mockRestore();
    }
    const observed: unknown[] = [];
    const during = await exportEntry(scope, {
      parseYieldEveryLines: 1,
      onTranscriptMessage: (message) => {
        observed.push(message);
        if (observed.length === 1) {
          expect(replaceEvents(scope, [first])).toBe(true);
        }
      },
    });

    expect(during).toEqual(before);
    expect(observed).toEqual([first.message, kept.message]);
    expect(cutoffDescriptor(during)).toMatchObject({
      configurable: false,
      enumerable: false,
      writable: false,
      value: { state: "valid", cutoffLine: 3 },
    });
    const after = await exportEntry(scope);
    expect(after.content).toBe("User: first");
    expect(cutoffDescriptor(after)?.value).toEqual({ state: "absent" });
  });

  it("carries the admitted input fence through the reset metadata worker", async () => {
    const scope = sessionScope("fence");
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    expect(replaceEvents(scope, [messageEvent("admitted", "user", "input", null)])).toBe(true);
    const anchor = readActiveTranscriptEntryAnchor({ ...scope, entryId: "admitted" });
    assert(anchor, "expected persisted input anchor");
    await appendTranscriptEvent(scope, { type: "reset", id: "later-reset", parentId: "admitted" });
    expect(await readCutoff(scope)).toEqual({ state: "valid", cutoffLine: 2 });
    expect(
      await withReadFence({ ...anchor, logicalTurnId: "metadata-read", role: "user" }, () =>
        readCutoff(scope),
      ),
    ).toEqual({ state: "absent" });
  });

  it("accepts a transcript append but invalidates its prefix hash after reset", async () => {
    await captureRuntimeConfigAsyncReader()();
    const scope = sessionScope("revision");
    const { storePath, sessionKey, sessionId } = scope;
    fsSync.mkdirSync(path.dirname(storePath), { recursive: true });
    await upsertSessionEntryCore(scope, { sessionId, updatedAt: 1 });
    await persist(scope, "user", "unchanged exported text");
    const buildOptions = { updatedAtMs: 1 };
    const before = await exportEntry(scope, buildOptions);
    const beforeLineCount = before.content.split("\n").length;

    await persist(scope, "assistant", "ordinary appended text");
    const afterAppend = await exportEntry(scope, buildOptions);
    expect(matchesSessionEntryPrefixHash(afterAppend, beforeLineCount, before.hash)).toBe(true);

    await resetSessionEntryLifecycle({
      agentId: "main",
      buildNextEntry: ({ currentEntry }) => ({
        ...currentEntry,
        sessionId,
        updatedAt: 2,
      }),
      resetBoundary: { context: "preserve-tail", reason: "reset", cwd: tmpDir },
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    });

    const after = await exportEntry(scope, buildOptions);
    expect(after).toMatchObject({ content: afterAppend.content, lineMap: afterAppend.lineMap });
    expect(cutoffDescriptor(after)).toMatchObject({
      enumerable: false,
      value: { state: "valid", cutoffLine: expect.any(Number) },
    });
    expect(Object.keys(after)).not.toContain(cutoffSymbol.description);
    expect(after.hash).not.toBe(before.hash);
    expect(matchesSessionEntryPrefixHash(after, beforeLineCount, before.hash)).toBe(false);
  });
});
