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
