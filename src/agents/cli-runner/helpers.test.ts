import { describe, expect, it } from "vitest";
import type { CliBackendConfig } from "../../config/types.js";
import { parseCliJson, parseCliJsonl } from "./helpers.js";

const DEFAULT_BACKEND = {} as CliBackendConfig;

describe("parseCliJson", () => {
  it("accepts a valid UUID session_id", () => {
    const raw = JSON.stringify({
      session_id: "550e8400-e29b-41d4-a716-446655440000",
      result: "hello",
    });
    const out = parseCliJson(raw, DEFAULT_BACKEND);
    expect(out?.sessionId).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  it("rejects error sentinel 'rate-limited' as session_id", () => {
    const raw = JSON.stringify({
      session_id: "rate-limited",
      result: "hello",
    });
    const out = parseCliJson(raw, DEFAULT_BACKEND);
    expect(out?.sessionId).toBeUndefined();
  });

  it("rejects short error sentinels like 'error' and 'none'", () => {
    for (const sentinel of ["error", "none", "null", "false"]) {
      const raw = JSON.stringify({ session_id: sentinel, result: "hi" });
      const out = parseCliJson(raw, DEFAULT_BACKEND);
      expect(out?.sessionId).toBeUndefined();
    }
  });

  it("rejects long sentinels with no digits", () => {
    for (const sentinel of ["blocked-now", "forbidden-access", "unavailable"]) {
      const raw = JSON.stringify({ session_id: sentinel, result: "hi" });
      const out = parseCliJson(raw, DEFAULT_BACKEND);
      expect(out?.sessionId).toBeUndefined();
    }
  });

  it("accepts OpenAI-style thread IDs via sessionIdFields", () => {
    const backend = {
      sessionIdFields: ["thread_id"],
    } as CliBackendConfig;
    const raw = JSON.stringify({
      thread_id: "thread_01abc2def345",
      result: "hello",
    });
    const out = parseCliJson(raw, backend);
    expect(out?.sessionId).toBe("thread_01abc2def345");
  });

  it("still parses text when session_id is rejected", () => {
    const raw = JSON.stringify({
      session_id: "rate-limited",
      result: "the response text",
    });
    const out = parseCliJson(raw, DEFAULT_BACKEND);
    expect(out?.text).toBe("the response text");
    expect(out?.sessionId).toBeUndefined();
  });
});

describe("parseCliJsonl", () => {
  it("rejects error sentinel in thread_id fallback", () => {
    const raw = JSON.stringify({
      thread_id: "rate-limited",
      item: { type: "message", text: "hello" },
    });
    const out = parseCliJsonl(raw, DEFAULT_BACKEND);
    expect(out?.sessionId).toBeUndefined();
  });

  it("accepts valid thread_id in fallback path", () => {
    const raw = JSON.stringify({
      thread_id: "thread_01abc2def345",
      item: { type: "message", text: "hello" },
    });
    const out = parseCliJsonl(raw, DEFAULT_BACKEND);
    expect(out?.sessionId).toBe("thread_01abc2def345");
  });
});
