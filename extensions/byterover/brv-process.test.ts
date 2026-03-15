import { describe, it, expect } from "vitest";
import { parseLastJsonLine } from "./brv-process.js";

describe("parseLastJsonLine", () => {
  it("parses a single JSON line", () => {
    const stdout =
      '{"command":"query","success":true,"timestamp":"2026-03-11","data":{"result":"hello"}}\n';
    const result = parseLastJsonLine<{ result: string }>(stdout);
    expect(result.command).toBe("query");
    expect(result.success).toBe(true);
    expect(result.data.result).toBe("hello");
  });

  it("returns the last JSON line from NDJSON stream", () => {
    const stdout = [
      '{"command":"query","success":true,"timestamp":"t1","data":{"event":"started"}}',
      '{"command":"query","success":true,"timestamp":"t2","data":{"event":"progress"}}',
      '{"command":"query","success":true,"timestamp":"t3","data":{"status":"completed","result":"final answer"}}',
    ].join("\n");
    const result = parseLastJsonLine<{ status: string; result: string }>(stdout);
    expect(result.data.status).toBe("completed");
    expect(result.data.result).toBe("final answer");
  });

  it("skips trailing non-JSON lines", () => {
    const stdout = [
      '{"command":"curate","success":true,"timestamp":"t1","data":{"status":"completed"}}',
      "some debug output",
      "",
    ].join("\n");
    const result = parseLastJsonLine<{ status: string }>(stdout);
    expect(result.data.status).toBe("completed");
  });

  it("throws on empty output", () => {
    expect(() => parseLastJsonLine("")).toThrow("No valid JSON in brv output");
  });

  it("throws on non-JSON output", () => {
    expect(() => parseLastJsonLine("not json\nalso not json\n")).toThrow(
      "No valid JSON in brv output",
    );
  });
});
