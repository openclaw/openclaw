import { describe, expect, it } from "vitest";
import {
  compareDailyVariantPathPreference,
  extractDailyMemoryDayFromPath,
  isDailyMemoryFileName,
  isSupportedShortTermMemoryPath,
  parseDailyMemoryFileName,
  parseDailyMemoryPathInfo,
} from "./daily-paths.js";

describe("daily-paths", () => {
  it("accepts canonical and dated-slug memory files", () => {
    expect(parseDailyMemoryFileName("2026-04-19.md")).toMatchObject({
      day: "2026-04-19",
      canonical: true,
    });
    expect(parseDailyMemoryFileName("2026-04-19-session-reset.md")).toMatchObject({
      day: "2026-04-19",
      slug: "session-reset",
      canonical: false,
    });
  });

  it("rejects non-daily markdown names", () => {
    expect(parseDailyMemoryFileName("memory.md")).toBeNull();
    expect(parseDailyMemoryFileName("2026-04-19 notes.md")).toBeNull();
    expect(isDailyMemoryFileName("2026-04-19-topic.md")).toBe(true);
    expect(isDailyMemoryFileName("notes.md")).toBe(false);
  });

  it("parses normalized daily-memory path info", () => {
    expect(parseDailyMemoryPathInfo("./memory/daily/2026-04-19-session-reset.md")).toEqual({
      normalizedPath: "memory/daily/2026-04-19-session-reset.md",
      dir: "memory/daily",
      day: "2026-04-19",
      slug: "session-reset",
      fileName: "2026-04-19-session-reset.md",
      canonical: false,
    });
    expect(extractDailyMemoryDayFromPath("memory/daily/2026-04-19-session-reset.md")).toBe(
      "2026-04-19",
    );
  });

  it("prefers canonical same-day variants but ignores unrelated paths", () => {
    expect(
      compareDailyVariantPathPreference("memory/2026-04-19.md", "memory/2026-04-19-reset.md"),
    ).toBeLessThan(0);
    expect(
      compareDailyVariantPathPreference("memory/2026-04-19-reset.md", "memory/2026-04-19.md"),
    ).toBeGreaterThan(0);
    expect(
      compareDailyVariantPathPreference(
        "memory/2026-04-19.md",
        "memory/archive/2026-04-19-reset.md",
      ),
    ).toBe(0);
  });

  it("matches the runtime-supported short-term memory path shapes", () => {
    expect(isSupportedShortTermMemoryPath("memory/2026-04-19.md")).toBe(true);
    expect(isSupportedShortTermMemoryPath("memory/2026-04-19.MD")).toBe(true);
    expect(isSupportedShortTermMemoryPath("2026-04-19-session-reset.md")).toBe(true);
    expect(isSupportedShortTermMemoryPath("2026-04-19-session-reset.MD")).toBe(true);
    expect(isSupportedShortTermMemoryPath("/tmp/workspace/memory/2026-04-19.md")).toBe(true);
    expect(isSupportedShortTermMemoryPath("memory/.dreams/session-corpus/2026-04-19.md")).toBe(
      true,
    );
    expect(isSupportedShortTermMemoryPath("memory/.dreams/session-corpus/2026-04-19.TXT")).toBe(
      true,
    );
    expect(isSupportedShortTermMemoryPath("memory/archive/2026-04-19.md")).toBe(false);
    expect(isSupportedShortTermMemoryPath("docs/memory/2026-04-19.md")).toBe(false);
    expect(isSupportedShortTermMemoryPath("/tmp/workspace/memory/daily/2026-04-19.md")).toBe(false);
    expect(isSupportedShortTermMemoryPath("memory/dreaming/2026-04-19.md")).toBe(false);
  });
});
