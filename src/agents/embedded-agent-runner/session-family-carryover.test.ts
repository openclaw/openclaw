import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { AgentMessage } from "../runtime/index.js";
import {
  installSessionFamilyCarryoverContextTransform,
  resolveSessionFamilyCarryoverSummary,
  shouldInstallSessionFamilyCarryoverContextTransform,
} from "./session-family-carryover.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-carryover-test-"));
  tempDirs.push(dir);
  return dir;
}

function writeTranscript(file: string, rows: unknown[]): void {
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf-8");
}

describe("session family carryover", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves the latest compaction summary from reset ancestor transcripts", async () => {
    const dir = makeTempDir();
    const storePath = path.join(dir, "sessions.json");
    const ancestorSessionId = "ancestor-session";
    const currentSessionId = "current-session";
    const activeSessionFile = path.join(dir, currentSessionId + ".jsonl");
    writeTranscript(path.join(dir, ancestorSessionId + ".jsonl.reset.2026-06-04T01-00-00.000Z"), [
      {
        type: "session",
        version: 1,
        id: ancestorSessionId,
        timestamp: "2026-06-04T00:00:00.000Z",
        cwd: dir,
      },
      {
        type: "compaction",
        id: "carryover-1",
        parentId: null,
        timestamp: "2026-06-04T00:30:00.000Z",
        summary: "Genome sequencing decisions and next action.",
        firstKeptEntryId: "msg-1",
        tokensBefore: 12_345,
      },
    ]);

    const entry = {
      sessionId: currentSessionId,
      sessionFile: activeSessionFile,
      usageFamilySessionIds: [ancestorSessionId, currentSessionId],
    } as SessionEntry;

    const carryover = await resolveSessionFamilyCarryoverSummary({
      sessionId: currentSessionId,
      sessionFile: activeSessionFile,
      storePath,
      entry,
    });

    expect(carryover).toMatchObject({
      role: "compactionSummary",
      summary: "Genome sequencing decisions and next action.",
      tokensBefore: 12_345,
      firstKeptEntryId: "msg-1",
    });
  });

  it("reads carryover summaries from the bounded tail of large reset archives", async () => {
    const dir = makeTempDir();
    const storePath = path.join(dir, "sessions.json");
    const ancestorSessionId = "ancestor-large-session";
    const currentSessionId = "current-session";
    const activeSessionFile = path.join(dir, currentSessionId + ".jsonl");
    const archiveFile = path.join(dir, ancestorSessionId + ".jsonl.reset.2026-06-04T01-00-00.000Z");
    const fillerRows = Array.from({ length: 1_200 }, (_, index) => ({
      type: "custom",
      id: `filler-${index}`,
      parentId: index === 0 ? null : `filler-${index - 1}`,
      timestamp: "2026-06-04T00:00:00.000Z",
      key: "carryover-test-filler",
      value: "x".repeat(512),
    }));
    writeTranscript(archiveFile, [
      {
        type: "session",
        version: 1,
        id: ancestorSessionId,
        timestamp: "2026-06-04T00:00:00.000Z",
        cwd: dir,
      },
      ...fillerRows,
      {
        type: "compaction",
        id: "tail-carryover",
        parentId: "filler-1199",
        timestamp: "2026-06-04T00:30:00.000Z",
        summary: "Large archive tail summary.",
        firstKeptEntryId: "tail-msg",
        tokensBefore: 22_222,
      },
    ]);
    expect(fs.statSync(archiveFile).size).toBeGreaterThan(512 * 1024);

    const entry = {
      sessionId: currentSessionId,
      sessionFile: activeSessionFile,
      usageFamilySessionIds: [ancestorSessionId, currentSessionId],
    } as SessionEntry;

    const carryover = await resolveSessionFamilyCarryoverSummary({
      sessionId: currentSessionId,
      sessionFile: activeSessionFile,
      storePath,
      entry,
    });

    expect(carryover).toMatchObject({
      role: "compactionSummary",
      summary: "Large archive tail summary.",
      tokensBefore: 22_222,
      firstKeptEntryId: "tail-msg",
    });
  });

  it("ignores unowned reset archives before prompt carryover", async () => {
    const dir = makeTempDir();
    const storePath = path.join(dir, "sessions.json");
    const ancestorSessionId = "ancestor-session";
    const currentSessionId = "current-session";
    const activeSessionFile = path.join(dir, currentSessionId + ".jsonl");
    writeTranscript(path.join(dir, ancestorSessionId + ".jsonl.reset.2026-06-04T01-00-00.000Z"), [
      {
        type: "session",
        version: 1,
        id: ancestorSessionId,
        timestamp: "2026-06-04T00:00:00.000Z",
        cwd: dir,
      },
      {
        type: "compaction",
        id: "carryover-1",
        parentId: null,
        timestamp: "2026-06-04T00:30:00.000Z",
        summary: "Owned ancestor decisions.",
        firstKeptEntryId: "owned-msg",
        tokensBefore: 12_345,
      },
    ]);
    writeTranscript(
      path.join(dir, ancestorSessionId + "-topic-secret.jsonl.reset.2026-06-04T02-00-00.000Z"),
      [
        {
          type: "session",
          version: 1,
          id: ancestorSessionId + "-topic-secret",
          timestamp: "2026-06-04T01:00:00.000Z",
          cwd: dir,
        },
        {
          type: "compaction",
          id: "wrong-carryover",
          parentId: null,
          timestamp: "2026-06-04T01:30:00.000Z",
          summary: "Unrelated topic decisions.",
          firstKeptEntryId: "wrong-msg",
          tokensBefore: 99_999,
        },
      ],
    );

    const entry = {
      sessionId: currentSessionId,
      sessionFile: activeSessionFile,
      usageFamilySessionIds: [ancestorSessionId, currentSessionId],
    } as SessionEntry;

    const carryover = await resolveSessionFamilyCarryoverSummary({
      sessionId: currentSessionId,
      sessionFile: activeSessionFile,
      storePath,
      entry,
    });

    expect(carryover).toMatchObject({
      role: "compactionSummary",
      summary: "Owned ancestor decisions.",
      tokensBefore: 12_345,
    });
  });

  it("caps family targets before reading carryover summaries", async () => {
    const dir = makeTempDir();
    const storePath = path.join(dir, "sessions.json");
    const currentSessionId = "current-capped-carryover";
    const activeSessionFile = path.join(dir, currentSessionId + ".jsonl");
    const ancestorSessionIds = Array.from(
      { length: 35 },
      (_, index) => `ancestor-capped-carryover-${String(index).padStart(2, "0")}`,
    );
    for (const [index, sessionId] of ancestorSessionIds.entries()) {
      writeTranscript(path.join(dir, sessionId + ".jsonl"), [
        {
          type: "compaction",
          id: `carryover-${index}`,
          parentId: null,
          timestamp: `2026-06-04T00:${String(index).padStart(2, "0")}:00.000Z`,
          summary: `Capped carryover ${index}`,
          firstKeptEntryId: `msg-${index}`,
          tokensBefore: 1_000 + index,
        },
      ]);
    }
    writeTranscript(activeSessionFile, [
      {
        type: "compaction",
        id: "active-carryover",
        parentId: null,
        timestamp: "2026-06-04T01:00:00.000Z",
        summary: "Active current summary should be skipped.",
        tokensBefore: 9_999,
      },
    ]);

    const entry = {
      sessionId: currentSessionId,
      sessionFile: activeSessionFile,
      usageFamilySessionIds: [...ancestorSessionIds, currentSessionId],
    } as SessionEntry;

    const carryover = await resolveSessionFamilyCarryoverSummary({
      sessionId: currentSessionId,
      sessionFile: activeSessionFile,
      storePath,
      entry,
    });

    expect(carryover).toMatchObject({
      role: "compactionSummary",
      summary: "Capped carryover 29",
      tokensBefore: 1_029,
    });
  });

  it("ignores newer compaction summaries from off-branch reset ancestors", async () => {
    const dir = makeTempDir();
    const storePath = path.join(dir, "sessions.json");
    const ancestorSessionId = "ancestor-session";
    const currentSessionId = "current-session";
    const activeSessionFile = path.join(dir, currentSessionId + ".jsonl");
    writeTranscript(path.join(dir, ancestorSessionId + ".jsonl.reset.2026-06-04T01-00-00.000Z"), [
      {
        type: "session",
        version: 1,
        id: ancestorSessionId,
        timestamp: "2026-06-04T00:00:00.000Z",
        cwd: dir,
      },
      {
        type: "message",
        id: "root-msg",
        parentId: null,
        timestamp: "2026-06-04T00:05:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "root" }], timestamp: 1 },
      },
      {
        type: "compaction",
        id: "off-branch-carryover",
        parentId: "root-msg",
        timestamp: "2026-06-04T00:50:00.000Z",
        summary: "Abandoned branch decisions.",
        firstKeptEntryId: "root-msg",
        tokensBefore: 99_999,
      },
      {
        type: "compaction",
        id: "active-carryover",
        parentId: "root-msg",
        timestamp: "2026-06-04T00:30:00.000Z",
        summary: "Active branch decisions.",
        firstKeptEntryId: "root-msg",
        tokensBefore: 12_345,
      },
      {
        type: "message",
        id: "active-leaf",
        parentId: "active-carryover",
        timestamp: "2026-06-04T00:40:00.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "active" }], timestamp: 2 },
      },
    ]);

    const entry = {
      sessionId: currentSessionId,
      sessionFile: activeSessionFile,
      usageFamilySessionIds: [ancestorSessionId, currentSessionId],
    } as SessionEntry;

    const carryover = await resolveSessionFamilyCarryoverSummary({
      sessionId: currentSessionId,
      sessionFile: activeSessionFile,
      storePath,
      entry,
    });

    expect(carryover).toMatchObject({
      role: "compactionSummary",
      summary: "Active branch decisions.",
      tokensBefore: 12_345,
      firstKeptEntryId: "root-msg",
    });
  });

  it("injects carryover once before the LLM boundary", async () => {
    const messages: AgentMessage[] = [
      { role: "user", content: [{ type: "text", text: "current ask" }], timestamp: 1 },
    ];
    let transformContext:
      | ((messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>)
      | undefined;
    installSessionFamilyCarryoverContextTransform({
      messages,
      getTransformContext: () => transformContext,
      setTransformContext: (transform) => {
        transformContext = transform;
      },
      resolveCarryover: async () => ({
        role: "compactionSummary",
        summary: "Prior thread summary.",
        tokensBefore: 100,
        timestamp: "2026-06-04T00:00:00.000Z",
      }),
    });

    const transformed = await transformContext?.(messages);
    expect(transformed?.map((message) => message.role)).toEqual(["compactionSummary", "user"]);

    const alreadySummarized = await transformContext?.(transformed ?? []);
    expect(alreadySummarized?.map((message) => message.role)).toEqual([
      "compactionSummary",
      "user",
    ]);
  });

  it("keeps reset-family carryover out of raw model runs", () => {
    expect(shouldInstallSessionFamilyCarryoverContextTransform({ isRawModelRun: true })).toBe(
      false,
    );
    expect(shouldInstallSessionFamilyCarryoverContextTransform({ isRawModelRun: false })).toBe(
      true,
    );
  });
});
