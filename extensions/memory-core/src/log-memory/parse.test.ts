import { describe, expect, it } from "vitest";
import { parseLogLine } from "./parse.js";

describe("parseLogLine", () => {
  it("parses ISO-prefixed plain text", () => {
    const result = parseLogLine("2026-05-07T12:34:56.789Z ERROR diagfw failed to bind probe");
    expect(result.timestamp.toISOString()).toBe("2026-05-07T12:34:56.789Z");
    expect(result.level).toBe("ERROR");
    expect(result.message).toContain("failed to bind probe");
  });

  it("parses JSON structured logs", () => {
    const line = JSON.stringify({
      timestamp: "2026-05-07T08:00:00Z",
      level: "warn",
      service: "diagfw",
      message: "stale handle",
    });
    const result = parseLogLine(line);
    expect(result.level).toBe("WARN");
    expect(result.service).toBe("diagfw");
    expect(result.message).toBe("stale handle");
    expect(result.timestamp.toISOString()).toBe("2026-05-07T08:00:00.000Z");
  });

  it("parses syslog-style lines", () => {
    const result = parseLogLine("Jan 15 10:00:00 dut-01 diagfw: ERROR probe stuck");
    expect(result.service).toBe("diagfw");
    expect(result.level).toBe("ERROR");
    expect(result.message).toBe("ERROR probe stuck");
  });

  it("treats unrecognized lines as INFO with current time", () => {
    const before = Date.now();
    const result = parseLogLine("hello world");
    const after = Date.now();
    expect(result.level).toBe("INFO");
    expect(result.message).toBe("hello world");
    expect(result.timestamp.getTime()).toBeGreaterThanOrEqual(before);
    expect(result.timestamp.getTime()).toBeLessThanOrEqual(after);
  });

  it("normalizes FATAL/CRITICAL to ERROR", () => {
    expect(parseLogLine("2026-05-07T08:00:00Z CRITICAL boom").level).toBe("ERROR");
    expect(parseLogLine("2026-05-07T08:00:00Z FATAL boom").level).toBe("ERROR");
  });

  it("handles numeric epoch timestamps in JSON", () => {
    const result = parseLogLine(JSON.stringify({ ts: 1_700_000_000, message: "ok" }));
    expect(result.timestamp.getTime()).toBe(1_700_000_000_000);
  });
});
