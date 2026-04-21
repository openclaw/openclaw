import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readSessionSummaryProbePrefixFromFile,
  SESSION_SUMMARY_DAILY_MEMORY_PROBE_MAX_BYTES,
} from "./daily-session-summary-io.js";
import {
  isSessionSummaryDailyMemory,
  SESSION_SUMMARY_DAILY_MEMORY_SENTINEL,
} from "./daily-session-summary.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("daily-session-summary-io", () => {
  it("caps probe reads to a bounded prefix", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-daily-summary-io-"));
    tmpDirs.push(root);
    const filePath = path.join(root, "2026-04-19-reset-summary.md");
    await fs.writeFile(
      filePath,
      [
        "# Session: 2026-04-19 10:00:00 America/New_York",
        "",
        SESSION_SUMMARY_DAILY_MEMORY_SENTINEL,
        "",
        "- **Session Key**: agent:main:main",
        "- **Session ID**: abc123",
        "- **Source**: cli",
        "",
        "assistant: bookkeeping only",
        "",
        "x".repeat(128 * 1024),
      ].join("\n"),
      "utf-8",
    );

    const prefix = await readSessionSummaryProbePrefixFromFile(filePath);

    expect(Buffer.byteLength(prefix, "utf-8")).toBeLessThanOrEqual(
      SESSION_SUMMARY_DAILY_MEMORY_PROBE_MAX_BYTES,
    );
    expect(isSessionSummaryDailyMemory(prefix)).toBe(true);
  });
});
