import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { emitSessionTranscriptUpdate } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  isSessionArchiveArtifactName,
  isUsageCountedSessionTranscriptFileName,
} from "openclaw/plugin-sdk/memory-core-host-engine-qmd";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Contract-only test: verifies the invariants the new archive-path bypass in
// `processSessionDeltaBatch` relies on. We don't spin the full memory manager
// here (that costs an embedding provider and a real sessions store); we lock
// in the two classification primitives + the event shape the listener needs,
// so a regression in any of them breaks this test before it reaches prod.

describe("archive event classification for session-delta bypass", () => {
  it("classifies .jsonl.reset.<iso> archives as usage-counted session artifacts", () => {
    const base = "agent-main-session.jsonl.reset.2026-05-03T05-38-59.000Z";
    expect(isSessionArchiveArtifactName(base)).toBe(true);
    expect(isUsageCountedSessionTranscriptFileName(base)).toBe(true);
  });

  it("classifies .jsonl.deleted.<iso> archives as usage-counted session artifacts", () => {
    const base = "agent-main-session.jsonl.deleted.2026-05-03T05-38-59.000Z";
    expect(isSessionArchiveArtifactName(base)).toBe(true);
    expect(isUsageCountedSessionTranscriptFileName(base)).toBe(true);
  });

  it("rejects .jsonl.bak.<iso> backups (archive but NOT usage-counted) so they do NOT bypass", () => {
    const base = "agent-main-session.jsonl.bak.2026-05-03T05-38-59.000Z";
    expect(isSessionArchiveArtifactName(base)).toBe(true);
    // .bak is opaque pre-archive; memory sync must treat it as normal
    // non-usage-counted (skipped by buildSessionEntry), and the bypass we
    // add in processSessionDeltaBatch must refuse to mark it dirty.
    expect(isUsageCountedSessionTranscriptFileName(base)).toBe(false);
  });

  it("rejects plain .jsonl live transcripts (non-archive) so they follow the normal delta path", () => {
    const base = "agent-main-session.jsonl";
    expect(isSessionArchiveArtifactName(base)).toBe(false);
    // Still usage-counted (it's a live transcript), but the bypass gate uses
    // archive classification to decide; live path falls through to the
    // existing delta-threshold accounting.
    expect(isUsageCountedSessionTranscriptFileName(base)).toBe(true);
  });

  it("compaction checkpoints are NOT archives and NOT usage-counted — delta path does not touch them", () => {
    const base = "ordinary.checkpoint.11111111-1111-4111-8111-111111111111.jsonl";
    expect(isSessionArchiveArtifactName(base)).toBe(false);
    expect(isUsageCountedSessionTranscriptFileName(base)).toBe(false);
  });
});

describe("session-transcript event bus carries archive paths end-to-end", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-archive-event-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("emitSessionTranscriptUpdate delivers the archived path verbatim to listeners", async () => {
    const archived = path.join(tmpDir, "stem.jsonl.reset.2026-05-03T05-38-59.000Z");
    await fs.writeFile(archived, "{}\n");

    const received: string[] = [];
    // onSessionTranscriptUpdate is re-exported through the memory-host-sdk
    // session files module; pulling it alongside the other primitives keeps
    // this test self-contained and matches how the memory manager listener
    // subscribes in production (see manager-sync-ops.ensureSessionListener).
    const { onSessionTranscriptUpdate } =
      await import("openclaw/plugin-sdk/memory-core-host-engine-foundation");
    const unsubscribe = onSessionTranscriptUpdate((update) => {
      received.push(update.sessionFile);
    });

    try {
      emitSessionTranscriptUpdate({ sessionFile: archived });
    } finally {
      unsubscribe();
    }

    expect(received).toEqual([archived]);
  });
});

describe("defensive: the bypass decision is purely filename-based", () => {
  it("works when the archived path has an absolute prefix that is unrelated to the session store", () => {
    const abs =
      "/tmp/some-other-agent/sessions/agent-main-session.jsonl.reset.2026-05-03T05-38-59.000Z";
    const baseName = path.basename(abs);
    expect(isSessionArchiveArtifactName(baseName)).toBe(true);
    expect(isUsageCountedSessionTranscriptFileName(baseName)).toBe(true);
  });

  it("works with nested archive subdirectories", () => {
    const abs = "/a/b/c/archive/stem.jsonl.deleted.2026-05-03T05-38-59.000Z";
    const baseName = path.basename(abs);
    expect(isSessionArchiveArtifactName(baseName)).toBe(true);
    expect(isUsageCountedSessionTranscriptFileName(baseName)).toBe(true);
  });
});

// Silence the spurious lint warning about unused vi import when the file is
// rendered outside a watch run.
vi.fn();
