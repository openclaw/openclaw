import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  captureRuntimeConfigAsyncReader,
  clearConfigCache,
  clearRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
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
import { replaceTranscriptEventsSync } from "../../../../src/config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { memorySessionActorOwners } from "../../../../src/config/sessions/session-actor-memory-owner.js";
import { runWithSessionTranscriptReadFence } from "../../../../src/config/sessions/session-transcript-read-fence.js";
import { registerSecretValueForRedaction } from "../../../../src/logging/secret-redaction-registry.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../../../src/state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../../../src/state/openclaw-agent-db.paths.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../../../src/state/openclaw-state-db.js";
import {
  buildSessionEntry,
  buildSessionEntries,
  matchesSessionEntryPrefixHash,
  type BuildSessionEntryOptions,
  type SessionFileEntry,
} from "./session-files.js";
import {
  readSessionResetRecallCutoff,
  readSessionResetRecallCutoffInProcess,
} from "./session-reset-recall-read.js";

function requireSessionEntry(entry: SessionFileEntry | null): SessionFileEntry {
  if (!entry) {
    throw new Error("expected session entry");
  }
  return entry;
}

let tmpDir: string;
let previousStateDir: string | undefined;
let previousConfigPath: string | undefined;

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
const userMessage = <T extends object>(content: unknown, metadata?: T) => ({
  role: "user",
  content,
  ...metadata,
});
const assistantMessage = <T extends object>(content: unknown, metadata?: T) => ({
  role: "assistant",
  content,
  ...metadata,
});
const internalMessage = (content: string, sourceTool: string) =>
  userMessage(content, { provenance: { kind: "internal_system", sourceTool } });
const appendMessage = (
  scope: ReturnType<typeof sessionScope>,
  eventId: string,
  message: Parameters<typeof appendTranscriptMessage>[1]["message"],
) => appendTranscriptMessage(scope, { eventId, message });
const exportEntry = async (
  scope: ReturnType<typeof sessionScope>,
  options: BuildSessionEntryOptions = {},
) => requireSessionEntry(await buildSessionEntry(scope.sessionKey, { ...scope, ...options }));

beforeEach(() => {
  tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "session-reset-revision-test-"));
  previousStateDir = process.env.OPENCLAW_STATE_DIR;
  previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
  Reflect.set(process.env, "OPENCLAW_STATE_DIR", tmpDir);
  clearRuntimeConfigSnapshot();
  clearConfigCache();
});

afterEach(async () => {
  memorySessionActorOwners.closeDatabase({
    agentId: "main",
    path: resolveIncognitoOpenClawAgentSqlitePath({
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: tmpDir },
    }),
  });
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  if (previousStateDir === undefined) {
    Reflect.deleteProperty(process.env, "OPENCLAW_STATE_DIR");
  } else {
    Reflect.set(process.env, "OPENCLAW_STATE_DIR", previousStateDir);
  }
  if (previousConfigPath === undefined) {
    Reflect.deleteProperty(process.env, "OPENCLAW_CONFIG_PATH");
  } else {
    Reflect.set(process.env, "OPENCLAW_CONFIG_PATH", previousConfigPath);
  }
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  fsSync.rmSync(tmpDir, { recursive: true, force: true });
});

describe("SQLite session snapshots and reset content revision", () => {
  it("keeps batched incremental exports current across sessions, appends and rewrites", async () => {
    const scope = sessionScope("incremental-export");
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const sibling = {
      ...scope,
      sessionId: "batch-sibling",
      sessionKey: "agent:main:chat:batch-sibling",
    };
    await upsertSessionEntryCore(sibling, { sessionId: sibling.sessionId, updatedAt: 1 });
    await appendMessage(sibling, "sibling-question", userMessage("A separate session preference."));
    const first = {
      type: "message",
      id: "heartbeat",
      message: internalMessage("Internal poll.", "heartbeat"),
    };
    expect(replaceTranscriptEventsSync(scope, [first])).toBe(true);
    const fullExport = () =>
      buildSessionEntry(scope.sessionKey, { ...scope, onTranscriptMessage() {} });
    let expectedSibling = "User: A separate session preference.";
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

    await appendMessage(
      scope,
      "heartbeat-answer",
      assistantMessage("Excluded heartbeat continuation."),
    );
    await appendMessage(
      scope,
      "question",
      userMessage("A searchable new preference.", { __openclaw: { senderIsOwner: true } }),
    );
    const appended = requireSessionEntry(await workerExport());
    expect(appended).toEqual(await fullExport());
    expect(appended).toMatchObject({ content: "User: A searchable new preference.", lineMap: [3] });
    expect(appended.lineProvenance[0]?.originClass).toBe("owner");
    expect(await workerExport()).toEqual(appended);

    await appendMessage(
      sibling,
      "sibling-answer",
      assistantMessage("The sibling's committed update."),
    );
    expectedSibling += "\nAssistant: The sibling's committed update.";

    expect(
      replaceTranscriptEventsSync(scope, [
        { ...first, message: userMessage("Rewritten searchable preference.") },
      ]),
    ).toBe(true);
    const rewritten = requireSessionEntry(await workerExport());
    expect(rewritten).toEqual(await fullExport());
    expect(rewritten).toMatchObject({
      content: "User: Rewritten searchable preference.",
      lineMap: [1],
    });
  });

  it.each(["interactive", "dreaming", "cron"])(
    "preserves SQLite/archive output and callback observations for %s transcripts",
    async (kind) => {
      const scope = sessionScope("parity");
      const observedAt = Date.parse("2026-07-01T10:00:00.000Z");
      const messages = [
        userMessage("Owner preference.", { __openclaw: { senderIsOwner: true } }),
        assistantMessage("Derived answer.", { __openclaw: { turnTainted: true } }),
        internalMessage("Internal poll.", "heartbeat"),
        { role: "toolResult", content: "Background result.", details: "x".repeat(64_000) },
        assistantMessage([
          {
            type: "toolCall",
            name: "write",
            arguments: { path: "MEMORY.md", content: "Internal note." },
          },
        ]),
        assistantMessage("Excluded heartbeat output."),
        internalMessage("Recalled text.", "memory_get"),
        assistantMessage("Excluded recalled output."),
        userMessage([{ type: "image", source: "photo.jpg" }], {
          __openclaw: { senderIsOwner: true },
        }),
        assistantMessage([{ type: "text", text: "Photo answer." }]),
        assistantMessage(
          [
            { type: "thinking", thinking: "x".repeat(64_000) },
            { type: "text", text: "" },
          ],
          {
            timestamp: 1000,
            providerReplay: { payload: "x".repeat(64_000) },
          },
        ),
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
      expect(replaceTranscriptEventsSync(scope, records)).toBe(true);
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
          kind === "interactive"
            ? "User: Owner preference.\nAssistant: Derived answer.\nAssistant: Photo answer."
            : "",
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
      const cutoff = Symbol.for("openclaw.memory.sessionResetRecallCutoff");
      expect(worker).toEqual(sqlite);
      expect(Object.getOwnPropertyDescriptor(worker, cutoff)).toEqual(
        Object.getOwnPropertyDescriptor(sqlite, cutoff),
      );
      expect(Object.getOwnPropertyDescriptor(sqlite, cutoff)).toEqual(
        Object.getOwnPropertyDescriptor(archive, cutoff),
      );
    },
  );

  it("preserves registered secret text in worker and inline transcript exports", async () => {
    const scope = sessionScope("registered-secret-export");
    const content = "API_TOKEN = computeToken() sk-abc123456789012345678";
    registerSecretValueForRedaction(content);
    const sessionEntry = { sessionId: scope.sessionId, updatedAt: 1 };
    await patchSessionEntryCore(scope, () => sessionEntry, {
      fallbackEntry: sessionEntry,
      skipMaintenance: true,
    });
    expect(replaceTranscriptEventsSync(scope, [messageEvent("source-text", "user", content)])).toBe(
      true,
    );
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
          "nonpersisting-export",
          incognito
            ? "agent:main:dashboard:incognito-export"
            : "agent:main:chat:nonpersisting-export",
        ),
        storePath: path.join(tmpDir, "agents", "main", "agent", "openclaw-agent.sqlite"),
      };
      expect(await buildSessionEntry(scope.sessionKey, scope)).toBeNull();
      expect(await buildSessionEntries([{ absPath: scope.sessionKey, options: scope }])).toEqual([
        null,
      ]);
      expect(await readSessionResetRecallCutoff(scope)).toEqual({ state: "invalid" });
      expect(fsSync.existsSync(scope.storePath)).toBe(false);
      await upsertSessionEntryCore(scope, {
        sessionId: scope.sessionId,
        updatedAt: 1,
        ...(incognito ? { incognito: true } : {}),
      });
      await appendMessage(scope, "visible", userMessage("Visible transcript"));
      expect((await buildSessionEntry(scope.sessionKey, scope))?.content).toBe(
        "User: Visible transcript",
      );
      const [batched] = await buildSessionEntries([{ absPath: scope.sessionKey, options: scope }]);
      expect(batched?.content).toBe("User: Visible transcript");
      expect(await readSessionResetRecallCutoff(scope)).toEqual({ state: "absent" });
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
    const scope = sessionScope("callback-snapshot", "agent:main:callback-snapshot");
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const first = messageEvent("first", "user", "first", null);
    const kept = messageEvent("kept", "assistant", "kept", "first");
    const records = [
      first,
      messageEvent("tool-result", "toolResult", "payload-only-probe".repeat(4096)),
      kept,
      { type: "reset", id: "reset", parentId: "kept", firstKeptEntryId: "kept" },
    ];
    expect(replaceTranscriptEventsSync(scope, records)).toBe(true);
    const before = await exportEntry(scope);
    expect(await readSessionResetRecallCutoff(scope)).toEqual({ state: "valid", cutoffLine: 3 });
    const parse = JSON.parse;
    const payloadGuard = vi.spyOn(JSON, "parse").mockImplementation((...args) => {
      if (args[0].includes("payload-only-probe")) {
        throw new Error("Reset metadata must not hydrate message payloads");
      }
      return Reflect.apply(parse, JSON, args);
    });
    try {
      expect(readSessionResetRecallCutoffInProcess(scope)).toEqual({
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
          expect(replaceTranscriptEventsSync(scope, [first])).toBe(true);
        }
      },
    });

    expect(during).toEqual(before);
    expect(observed).toEqual([first.message, kept.message]);
    const cutoff = Symbol.for("openclaw.memory.sessionResetRecallCutoff");
    expect(Object.getOwnPropertyDescriptor(during, cutoff)).toMatchObject({
      configurable: false,
      enumerable: false,
      writable: false,
      value: { state: "valid", cutoffLine: 3 },
    });
    const after = await exportEntry(scope);
    expect(after.content).toBe("User: first");
    expect(Object.getOwnPropertyDescriptor(after, cutoff)?.value).toEqual({ state: "absent" });
  });

  it("carries the admitted input fence through the reset metadata worker", async () => {
    const scope = sessionScope("metadata-fence");
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    expect(
      replaceTranscriptEventsSync(scope, [messageEvent("admitted", "user", "input", null)]),
    ).toBe(true);
    const anchor = readActiveTranscriptEntryAnchor({ ...scope, entryId: "admitted" });
    if (!anchor) {
      throw new Error("expected persisted input anchor");
    }
    await appendTranscriptEvent(scope, { type: "reset", id: "later-reset", parentId: "admitted" });
    expect(await readSessionResetRecallCutoff(scope)).toEqual({ state: "valid", cutoffLine: 2 });
    expect(
      await runWithSessionTranscriptReadFence(
        { ...anchor, logicalTurnId: "metadata-read", role: "user" },
        () => readSessionResetRecallCutoff(scope),
      ),
    ).toEqual({ state: "absent" });
  });

  it("accepts a transcript append but invalidates its prefix hash after reset", async () => {
    await captureRuntimeConfigAsyncReader()();
    const scope = sessionScope("reset-revision");
    const { storePath, sessionKey, sessionId } = scope;
    fsSync.mkdirSync(path.dirname(storePath), { recursive: true });
    await upsertSessionEntryCore(scope, { sessionId, updatedAt: 1 });
    await persistSessionTranscriptTurn(scope, {
      messages: [{ message: { role: "user", content: "unchanged exported text" } }],
      touchSessionEntry: true,
      updateMode: "none",
    });
    const buildOptions = { updatedAtMs: 1 };
    const before = await exportEntry(scope, buildOptions);
    const beforeLineCount = before.content.split("\n").length;

    await persistSessionTranscriptTurn(scope, {
      messages: [{ message: { role: "assistant", content: "ordinary appended text" } }],
      touchSessionEntry: true,
      updateMode: "none",
    });
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
    const cutoffSymbol = Symbol.for("openclaw.memory.sessionResetRecallCutoff");
    expect(Object.getOwnPropertyDescriptor(after, cutoffSymbol)).toMatchObject({
      enumerable: false,
      value: { state: "valid", cutoffLine: expect.any(Number) },
    });
    expect(Object.keys(after)).not.toContain(cutoffSymbol.description);
    expect(after.hash).not.toBe(before.hash);
    expect(matchesSessionEntryPrefixHash(after, beforeLineCount, before.hash)).toBe(false);
  });
});
