import { createHash } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveSessionTranscriptsDirForAgent } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  buildSessionEntry,
  listSessionTranscriptCorpusEntriesForAgent,
} from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  appendSessionTranscriptMessageByIdentity,
  readSessionTranscriptEvents,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { resolveOpenClawAgentSqlitePath } from "openclaw/plugin-sdk/sqlite-runtime";
import { appendSqliteSessionTranscriptEventForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { assert, expect, it } from "vitest";
import {
  scanSessionIngestionSource,
  sessionIngestionSourceFromCorpus,
} from "../session-ingestion.js";
import { createManagerIndexFixture } from "./manager-index.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

const sessionId = "mixed-export";
const sessionKey = `agent:main:chat:${sessionId}`;
const day = (minute: number) => `2026-09-01T10:${String(minute).padStart(2, "0")}:00.000Z`;
const message = (id: string, minute: number, body: Record<string, unknown>) => ({
  type: "message",
  id,
  timestamp: day(minute),
  message: { timestamp: Date.parse(day(minute)), ...body },
});
const owner = (text: string) => ({
  role: "user",
  content: [{ type: "text", text }],
  __openclaw: { senderIsOwner: true },
});
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const long = (label: string) =>
  Array.from({ length: 140 }, (_, index) => `${label} word${index}`).join(" ");

/** user/assistant/toolResult turns with heartbeat, compaction and reset boundaries. */
const initialEvents = [
  { type: "custom", customType: "metadata", data: {} },
  message("m1", 1, owner("Remember that the staging cluster runs in eu-west-2.")),
  message("m2", 2, assistant("Noted: staging lives in eu-west-2.")),
  message("m3", 3, {
    role: "assistant",
    content: [{ type: "toolCall", name: "read", arguments: { path: "notes.md" } }],
  }),
  message("m4", 4, { role: "toolResult", content: "notes.md contents: unrelated tool output" }),
  message("m5", 5, assistant(long("Tool summary"))),
  message("m6", 6, {
    role: "user",
    content: "Heartbeat poll.",
    provenance: { kind: "internal_system", sourceTool: "heartbeat" },
  }),
  message("m7", 7, assistant("HEARTBEAT_OK")),
  { type: "compaction", id: "c1", firstKeptEntryId: "m5", summary: "Earlier turns compacted." },
  message("m8", 8, owner(long("Owner detail"))),
  message("m9", 9, assistant("Derived answer after compaction.")),
  { type: "reset", id: "r1", firstKeptEntryId: "m8", reason: "reset", timestamp: day(10) },
  message("m10", 11, owner("After the reset, prefer concise answers.")),
  message("m11", 12, assistant("Understood, concise answers from now on.")),
];
const appendedEvents = [
  message("m12", 13, owner("Appended preference: deploy on Tuesdays.")),
  message("m13", 14, assistant(long("Appended reply"))),
];
// A later reset moves the recall boundary, so the earlier checkpoint's prefix no longer matches.
const resetEvents = [
  { type: "reset", id: "r2", firstKeptEntryId: "m12", reason: "reset", timestamp: day(15) },
  message("m14", 16, owner("Second reset: keep answers in bullet points.")),
];

const fixture = createManagerIndexFixture({ getMemorySearchManager, closeAllMemorySearchManagers });

it("indexes, hashes and ingests a mixed session export identically to the full export", async () => {
  const storePath = path.join(resolveSessionTranscriptsDirForAgent("main"), "sessions.json");
  const target = { agentId: "main", sessionId, sessionKey, storePath };
  await upsertSessionEntry({
    agentId: "main",
    sessionKey,
    storePath,
    entry: { sessionId, updatedAt: 1 },
  });
  // Messages enter through the transcript owner; boundaries name their logical message ids.
  const ids = new Map<string, string>();
  const append = async (events: readonly Record<string, unknown>[]) => {
    for (const { id, ...event } of events) {
      if (event.type === "message") {
        await appendSessionTranscriptMessageByIdentity({
          ...target,
          message: event.message as Parameters<
            typeof appendSessionTranscriptMessageByIdentity
          >[0]["message"],
        });
        const last = (await readSessionTranscriptEvents(target)).at(-1);
        ids.set(String(id), String(asOptionalRecord(last)?.id));
        continue;
      }
      const kept = typeof event.firstKeptEntryId === "string" ? event.firstKeptEntryId : undefined;
      await appendSqliteSessionTranscriptEventForTest({
        ...target,
        event: { ...event, id, ...(kept ? { firstKeptEntryId: ids.get(kept) } : {}) },
      });
    }
  };
  await append(initialEvents);
  const corpus = async () => {
    const entry = (await listSessionTranscriptCorpusEntriesForAgent("main")).find(
      (candidate) => candidate.sessionId === sessionId,
    );
    assert.isDefined(entry, "expected the mixed session in the corpus");
    return entry;
  };
  const exported = async () => {
    const entry = await buildSessionEntry((await corpus()).sessionFile, {
      ...target,
      sessionKind: "interactive",
    });
    assert.isNotNull(entry, "expected the mixed session export");
    return {
      hash: entry.hash,
      content: entry.content,
      lineMap: entry.lineMap,
      messageTimestampsMs: entry.messageTimestampsMs,
      lineProvenance: entry.lineProvenance,
    };
  };
  const ingest = async (
    previous?: Awaited<ReturnType<typeof scanSessionIngestionSource>>["fileState"],
  ) => {
    const source = sessionIngestionSourceFromCorpus(await corpus(), "dreaming");
    assert.isNotNull(source, "expected a dreaming ingestion source");
    const scan = await scanSessionIngestionSource({
      source,
      previous,
      seenMessages: {},
      timezone: "UTC",
      maxCandidates: 6,
      classifyDay: () => "include",
    });
    return {
      status: scan.status,
      scannedEndIndex: scan.scannedEndIndex,
      fileState: scan.fileState && {
        contentHash: scan.fileState.contentHash,
        lineCount: scan.fileState.lineCount,
        lastContentLine: scan.fileState.lastContentLine,
      },
      candidates: scan.candidates.map(({ sessionOrigin: _origin, ...candidate }) => candidate),
      previousFileState: scan.fileState,
    };
  };
  const indexed = async () => {
    const cfg = fixture.createConfig({
      provider: "none",
      sources: ["sessions"],
      sessionMemory: true,
    });
    const manager = await fixture.getFreshManager(cfg, "cli");
    await manager.sync({ reason: "equivalence", force: true });
    using db = new DatabaseSync(resolveOpenClawAgentSqlitePath({ agentId: "main" }), {
      readOnly: true,
    });
    return {
      chunks: db
        .prepare(
          `SELECT c.path, c.start_line, c.end_line, c.hash, c.text,
             p.origin_class, p.session_kind, p.observed_at, p.supersedes_key
           FROM memory_index_chunks c
           LEFT JOIN memory_index_chunk_provenance p ON p.chunk_id = c.id
           WHERE c.source = 'sessions'
           ORDER BY c.path, c.start_line, c.end_line, c.hash`,
        )
        .all(),
      sourceHash: String(
        db.prepare("SELECT hash FROM memory_index_sources WHERE source = 'sessions'").get()?.hash,
      ).replace(/^sqlite:\d+:/, ""),
    };
  };

  const before = await exported();
  const firstScan = await ingest();
  const firstIndex = await indexed();
  await append(appendedEvents);
  const after = await exported();
  const appendScan = await ingest(firstScan.previousFileState);
  const unchangedScan = await ingest(appendScan.previousFileState);
  const secondIndex = await indexed();
  await append(resetEvents);
  const reset = await exported();
  const resetScan = await ingest(unchangedScan.previousFileState);
  const thirdIndex = await indexed();
  const digest = {
    before,
    after,
    firstScan: { ...firstScan, previousFileState: undefined },
    appendScan: { ...appendScan, previousFileState: undefined },
    unchangedScan: { ...unchangedScan, previousFileState: undefined },
    reset,
    resetScan: { ...resetScan, previousFileState: undefined },
    firstIndex,
    secondIndex,
    thirdIndex,
  };
  expect(firstIndex.sourceHash).toBe(before.hash);
  expect(secondIndex.sourceHash).toBe(after.hash);
  expect(firstScan.fileState?.contentHash).toBe(before.hash);
  expect(appendScan.fileState?.contentHash).toBe(after.hash);
  expect(resetScan.candidates[0]?.contentIndex).toBe(0);
  expect(thirdIndex.sourceHash).toBe(reset.hash);
  const fingerprint = createHash("sha256").update(JSON.stringify(digest)).digest("hex");
  // Captured on the full-export implementation (625945b) before the paged export cutover.
  expect({ fingerprint, before: before.hash, after: after.hash, reset: reset.hash }).toEqual(
    EXPECTED,
  );
});

const EXPECTED = {
  fingerprint: "457e078f88d093e7eb951c79bc63d830e8b9cc4cbee1e853a6fe5e43dbd06a15",
  before: "66f392208f18d6f0679fc4601e30fda2b145659c9dbd0359ba0dcf8075251763",
  after: "7b318b45bb70c90c896bec85d3330770ca62979712291411ff7c8f01ce11c684",
  reset: "302503e54e06a36d46d3a11963f5458cdb3de325549e62c45b9705f542f38372",
};
