import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  filterSessionSummaryDailyMemoryFiles,
  isSessionSummaryDailyMemory,
} from "./daily-content.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("daily-content", () => {
  it("detects session-summary bookkeeping content", () => {
    expect(
      isSessionSummaryDailyMemory(
        [
          "# Session: 2026-04-19 10:00:00 America/New_York",
          "",
          "- **Session Key**: agent:main:main",
          "- **Session ID**: abc123",
          "- **Source**: cli",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(isSessionSummaryDailyMemory("# Notes\n\nRegular daily memory.")).toBe(false);
  });

  it("filters session-summary bookkeeping files out of grounded-memory inputs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-daily-content-"));
    tmpDirs.push(root);
    const notePath = path.join(root, "2026-04-19.md");
    const sessionSummaryPath = path.join(root, "2026-04-19-session-reset.md");
    await fs.writeFile(notePath, "## Durable Notes\n\nKeep this.\n", "utf-8");
    await fs.writeFile(
      sessionSummaryPath,
      [
        "# Session: 2026-04-19 10:00:00 America/New_York",
        "",
        "- **Session Key**: agent:main:main",
        "- **Session ID**: abc123",
        "- **Source**: cli",
        "",
        "assistant: bookkeeping only",
      ].join("\n") + "\n",
      "utf-8",
    );

    await expect(
      filterSessionSummaryDailyMemoryFiles([notePath, sessionSummaryPath]),
    ).resolves.toEqual([notePath]);
  });
});
