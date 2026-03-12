import { describe, expect, it } from "vitest";
import type { CliBackendConfig } from "../../config/types.js";
import { parseCliJson, parseCliJsonl } from "./helpers.js";

describe("cli session id parsing", () => {
  it("ignores non-uuid session ids for uuid backends", () => {
    const backend: CliBackendConfig = {
      command: "claude",
      output: "json",
      sessionIdFormat: "uuid",
    };

    const parsed = parseCliJson(
      JSON.stringify({
        message: "rate limited",
        session_id: "rate-limited",
      }),
      backend,
    );

    expect(parsed).toEqual({
      text: "rate limited",
      sessionId: undefined,
      usage: undefined,
    });
  });

  it("keeps valid uuid session ids for uuid backends", () => {
    const backend: CliBackendConfig = {
      command: "claude",
      output: "json",
      sessionIdFormat: "uuid",
    };

    const parsed = parseCliJson(
      JSON.stringify({
        message: "ok",
        session_id: "550e8400-e29b-41d4-a716-446655440000",
      }),
      backend,
    );

    expect(parsed?.sessionId).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  it("preserves opaque thread ids for non-uuid backends", () => {
    const backend: CliBackendConfig = {
      command: "codex",
      output: "jsonl",
      sessionIdFields: ["thread_id"],
      sessionIdFormat: "opaque",
    };

    const parsed = parseCliJsonl(
      [
        JSON.stringify({ thread_id: "thread_abc123" }),
        JSON.stringify({
          item: { type: "message", text: "hello" },
        }),
      ].join("\n"),
      backend,
    );

    expect(parsed).toEqual({
      text: "hello",
      sessionId: "thread_abc123",
      usage: undefined,
    });
  });
});
