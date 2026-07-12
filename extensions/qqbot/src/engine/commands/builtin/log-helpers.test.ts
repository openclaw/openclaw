// Qqbot tests cover log helpers plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const platformMock = await vi.hoisted(async () => {
  const fsLocal = await import("node:fs");
  const pathLocal = await import("node:path");
  return {
    fs: fsLocal,
    homeDir: "",
    path: pathLocal,
  };
});

vi.mock("../../utils/platform.js", () => ({
  getHomeDir: () => platformMock.homeDir,
  getQQBotDataDir: (...subPaths: string[]) => {
    const dir = platformMock.path.join(platformMock.homeDir, ".openclaw", "qqbot", ...subPaths);
    platformMock.fs.mkdirSync(dir, { recursive: true });
    return dir;
  },
  isWindows: () => false,
}));

import { buildBotLogsResult } from "./log-helpers.js";

describe("buildBotLogsResult", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-qqbot-logs-"));
    platformMock.homeDir = tempHome;
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("suffixes same-second log exports instead of overwriting", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-05T10:11:12.345Z"));
    const logDir = path.join(tempHome, ".openclaw", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, "gateway.log"), "line 1\nline 2\n", "utf8");

    const first = buildBotLogsResult();
    const second = buildBotLogsResult();

    expect(typeof first).toBe("object");
    expect(typeof second).toBe("object");
    if (!first || !second || typeof first === "string" || typeof second === "string") {
      throw new Error("expected file upload results");
    }
    expect(path.basename(first.filePath)).toBe("bot-logs-2026-05-05T10-11-12.txt");
    expect(path.basename(second.filePath)).toBe("bot-logs-2026-05-05T10-11-12-2.txt");
    expect(fs.readFileSync(first.filePath, "utf8")).toContain("line 1");
    expect(fs.readFileSync(second.filePath, "utf8")).toContain("line 2");
  });

  it("does not count a trailing newline as an exported log line", () => {
    const logDir = path.join(tempHome, ".openclaw", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const lines = Array.from({ length: 1001 }, (_, i) => `entry-${String(i + 1).padStart(4, "0")}`);
    fs.writeFileSync(path.join(logDir, "gateway.log"), `${lines.join("\n")}\n`, "utf8");

    const result = buildBotLogsResult();

    expect(typeof result).toBe("object");
    if (!result || typeof result === "string") {
      throw new Error("expected file upload result");
    }
    const exported = fs.readFileSync(result.filePath, "utf8");
    expect(exported).toContain("gateway.log (last 1000 of 1001 lines)");
    expect(exported).not.toContain("entry-0001");
    expect(exported).toContain("entry-0002");
    expect(exported.endsWith("entry-1001")).toBe(true);
  });
});
