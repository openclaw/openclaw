// Memory Wiki tests cover time plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveMemoryWikiTimestamp } from "./time.js";

describe("resolveMemoryWikiTimestamp", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back when injected timestamps are outside Date range", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 4, 30, 12, 0, 0));

    expect(resolveMemoryWikiTimestamp(8_640_000_000_000_001)).toBe("2026-05-30T12:00:00.000Z");
  });
});
