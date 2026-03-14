import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { JsonlTraceWriter } from "./storage-jsonl.js";
import type { TraceSpan } from "./types.js";

function makeSpan(overrides: Partial<TraceSpan> = {}): TraceSpan {
  return {
    traceId: "trace-1",
    spanId: "span-1",
    kind: "llm_call",
    name: "test-span",
    startMs: Date.now(),
    attributes: {},
    ...overrides,
  };
}

describe("JsonlTraceWriter", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jsonl-trace-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("constructor", () => {
    it("creates the directory if it does not exist", () => {
      const nested = path.join(tmpDir, "a", "b", "c");
      new JsonlTraceWriter(nested);
      expect(fs.existsSync(nested)).toBe(true);
    });

    it("works when directory already exists", () => {
      // tmpDir already exists; should not throw
      const writer = new JsonlTraceWriter(tmpDir);
      expect(writer).toBeDefined();
    });
  });

  describe("write", () => {
    it("writes a span as a JSON line to a date-keyed file", () => {
      const writer = new JsonlTraceWriter(tmpDir);
      const span = makeSpan({ startMs: new Date("2026-03-09T12:00:00Z").getTime() });
      writer.write(span);

      const filePath = path.join(tmpDir, "2026-03-09.jsonl");
      expect(fs.existsSync(filePath)).toBe(true);

      const content = fs.readFileSync(filePath, "utf-8").trim();
      const parsed = JSON.parse(content);
      expect(parsed.traceId).toBe("trace-1");
      expect(parsed.spanId).toBe("span-1");
    });

    it("appends multiple spans to the same file", () => {
      const writer = new JsonlTraceWriter(tmpDir);
      const ts = new Date("2026-03-09T12:00:00Z").getTime();
      writer.write(makeSpan({ spanId: "s1", startMs: ts }));
      writer.write(makeSpan({ spanId: "s2", startMs: ts }));

      const filePath = path.join(tmpDir, "2026-03-09.jsonl");
      const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).spanId).toBe("s1");
      expect(JSON.parse(lines[1]).spanId).toBe("s2");
    });

    it("writes to different files for different dates", () => {
      const writer = new JsonlTraceWriter(tmpDir);
      writer.write(makeSpan({ startMs: new Date("2026-03-08T23:00:00Z").getTime() }));
      writer.write(makeSpan({ startMs: new Date("2026-03-09T01:00:00Z").getTime() }));

      expect(fs.existsSync(path.join(tmpDir, "2026-03-08.jsonl"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "2026-03-09.jsonl"))).toBe(true);
    });
  });

  describe("readByDate", () => {
    it("returns an empty array when the file does not exist", () => {
      const writer = new JsonlTraceWriter(tmpDir);
      expect(writer.readByDate("2026-01-01")).toEqual([]);
    });

    it("returns all spans from a date file", () => {
      const writer = new JsonlTraceWriter(tmpDir);
      const ts = new Date("2026-03-09T10:00:00Z").getTime();
      writer.write(makeSpan({ spanId: "a", startMs: ts }));
      writer.write(makeSpan({ spanId: "b", startMs: ts }));

      const spans = writer.readByDate("2026-03-09");
      expect(spans).toHaveLength(2);
      expect(spans[0].spanId).toBe("a");
      expect(spans[1].spanId).toBe("b");
    });

    it("skips empty or malformed lines gracefully", () => {
      // Write a file with a bad line
      const filePath = path.join(tmpDir, "2026-03-09.jsonl");
      const good = JSON.stringify(makeSpan({ spanId: "ok" }));
      fs.writeFileSync(filePath, `${good}\n{bad json\n\n${good}\n`);

      const writer = new JsonlTraceWriter(tmpDir);
      const spans = writer.readByDate("2026-03-09");
      expect(spans).toHaveLength(2);
      expect(spans[0].spanId).toBe("ok");
    });
  });

  describe("readToday", () => {
    it("reads spans written today", () => {
      const writer = new JsonlTraceWriter(tmpDir);
      // Write a span with current time (defaults to today)
      writer.write(makeSpan({ spanId: "today-span" }));

      const spans = writer.readToday();
      expect(spans.length).toBeGreaterThanOrEqual(1);
      expect(spans.some((s) => s.spanId === "today-span")).toBe(true);
    });
  });

  describe("listDates", () => {
    it("returns an empty array when no files exist", () => {
      const writer = new JsonlTraceWriter(tmpDir);
      expect(writer.listDates()).toEqual([]);
    });

    it("returns date keys sorted newest first", () => {
      const writer = new JsonlTraceWriter(tmpDir);
      // Create files manually
      fs.writeFileSync(path.join(tmpDir, "2026-03-07.jsonl"), "{}");
      fs.writeFileSync(path.join(tmpDir, "2026-03-09.jsonl"), "{}");
      fs.writeFileSync(path.join(tmpDir, "2026-03-08.jsonl"), "{}");

      const dates = writer.listDates();
      expect(dates).toEqual(["2026-03-09", "2026-03-08", "2026-03-07"]);
    });

    it("ignores non-jsonl files", () => {
      const writer = new JsonlTraceWriter(tmpDir);
      fs.writeFileSync(path.join(tmpDir, "2026-03-09.jsonl"), "{}");
      fs.writeFileSync(path.join(tmpDir, "notes.txt"), "hello");

      const dates = writer.listDates();
      expect(dates).toEqual(["2026-03-09"]);
    });
  });

  describe("cleanup", () => {
    it("removes files older than the retention period", () => {
      const writer = new JsonlTraceWriter(tmpDir);

      // Use relative dates so the test doesn't rot
      const toKey = (d: Date) => d.toISOString().slice(0, 10);
      const now = new Date();
      const todayDate = toKey(now);
      const recentDate = toKey(new Date(now.getTime() - 2 * 86400000));
      const oldDate = toKey(new Date(now.getTime() - 30 * 86400000));

      fs.writeFileSync(path.join(tmpDir, `${oldDate}.jsonl`), "{}");
      fs.writeFileSync(path.join(tmpDir, `${recentDate}.jsonl`), "{}");
      fs.writeFileSync(path.join(tmpDir, `${todayDate}.jsonl`), "{}");

      // Retain only 7 days — old file should be removed
      writer.cleanup(7);

      expect(fs.existsSync(path.join(tmpDir, `${oldDate}.jsonl`))).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, `${recentDate}.jsonl`))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, `${todayDate}.jsonl`))).toBe(true);
    });

    it("does not remove anything when all files are within retention", () => {
      const writer = new JsonlTraceWriter(tmpDir);
      fs.writeFileSync(path.join(tmpDir, "2026-03-09.jsonl"), "{}");

      writer.cleanup(30);

      expect(fs.existsSync(path.join(tmpDir, "2026-03-09.jsonl"))).toBe(true);
    });

    it("handles empty directory gracefully", () => {
      const writer = new JsonlTraceWriter(tmpDir);
      // Should not throw
      expect(() => writer.cleanup(7)).not.toThrow();
    });
  });
});
