import { describe, expect, it } from "vitest";
import type { CliBackendConfig } from "../../config/types.js";
import { parseCliJson, parseCliJsonl } from "./helpers.js";

describe("parseCliJson – pickSessionId UUID validation", () => {
  const backend: CliBackendConfig = { command: "test-cli" };

  it("accepts a valid UUID session_id", () => {
    const raw = JSON.stringify({
      session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      content: "hello",
    });
    const result = parseCliJson(raw, backend);
    expect(result?.sessionId).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
  });

  it("rejects non-UUID string like 'rate-limited'", () => {
    const raw = JSON.stringify({
      session_id: "rate-limited",
      content: "hello",
    });
    const result = parseCliJson(raw, backend);
    expect(result?.sessionId).toBeUndefined();
  });

  it("rejects an empty string", () => {
    const raw = JSON.stringify({
      session_id: "",
      content: "hello",
    });
    const result = parseCliJson(raw, backend);
    expect(result?.sessionId).toBeUndefined();
  });

  it("returns undefined when session_id field is missing", () => {
    const raw = JSON.stringify({ content: "hello" });
    const result = parseCliJson(raw, backend);
    expect(result?.sessionId).toBeUndefined();
  });

  it("accepts uppercase UUID", () => {
    const raw = JSON.stringify({
      session_id: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
      content: "hello",
    });
    const result = parseCliJson(raw, backend);
    expect(result?.sessionId).toBe("A1B2C3D4-E5F6-7890-ABCD-EF1234567890");
  });

  it("rejects a numeric string", () => {
    const raw = JSON.stringify({
      session_id: "12345",
      content: "hello",
    });
    const result = parseCliJson(raw, backend);
    expect(result?.sessionId).toBeUndefined();
  });
});

describe("parseCliJsonl – thread_id UUID validation", () => {
  const backend: CliBackendConfig = { command: "test-cli" };

  it("accepts a valid UUID thread_id", () => {
    const lines = [
      JSON.stringify({
        thread_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        item: { text: "hello", type: "message" },
      }),
    ].join("\n");
    const result = parseCliJsonl(lines, backend);
    expect(result?.sessionId).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
  });

  it("rejects non-UUID thread_id", () => {
    const lines = [
      JSON.stringify({
        thread_id: "rate-limited",
        item: { text: "hello", type: "message" },
      }),
    ].join("\n");
    const result = parseCliJsonl(lines, backend);
    expect(result?.sessionId).toBeUndefined();
  });
});
