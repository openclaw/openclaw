import { describe, expect, it } from "vitest";
import type { JsonObject } from "./protocol.js";
import { toTranscriptToolResult } from "./run-attempt-tools.js";
import {
  sanitizeCodexAgentEventRecord,
  sanitizeCodexToolArguments,
} from "./tool-progress-normalization.js";

describe("Codex tool progress payloads", () => {
  it.each([
    ["event records", sanitizeCodexAgentEventRecord],
    ["dynamic tool arguments", sanitizeCodexToolArguments],
  ] as const)("preserves redacted own JSON keys in %s", (_label, sanitize) => {
    const input: JsonObject = JSON.parse(
      '{"__proto__":{"label":"kept","token":"fixture-value"},"nested":{"__proto__":null}}',
    );
    const before = JSON.stringify(input);

    const result = sanitize(input);

    expect(JSON.stringify(result)).toBe(
      '{"__proto__":{"label":"kept","token":"***"},"nested":{"__proto__":null}}',
    );
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(result?.nested)).toBe(Object.prototype);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("bounds cyclic and repeated references without mutating tool arguments", () => {
    const shared = { token: "fixture-value", label: "kept" };
    const input: JsonObject = { first: shared, repeated: shared, array: [] };
    input.self = input;
    input.array = [input, shared];

    const result = sanitizeCodexToolArguments(input);

    expect(result).toEqual({
      first: { token: "***", label: "kept" },
      repeated: "[Circular]",
      array: ["[Circular]", "[Circular]"],
      self: "[Circular]",
    });
    expect(input.first).toBe(shared);
    expect(input.repeated).toBe(shared);
    expect(input.self).toBe(input);
    expect(input.array).toEqual([input, shared]);
    expect(shared.token).toBe("fixture-value");
  });

  it("keeps redacted JSON details and native content when projecting a transcript result", () => {
    const details: JsonObject = JSON.parse(
      '{"__proto__":{"label":"kept","token":"fixture-value"}}',
    );
    const text = `Authorization: Bearer abcdef0123456789QWERTY=\n${"output ".repeat(1500)}`;
    const imageUrl = "data:image/png;base64,aW1hZ2UtZml4dHVyZQ==";
    const response = {
      success: true,
      contentItems: [
        { type: "inputText" as const, text },
        { type: "inputImage" as const, imageUrl },
      ],
      details,
    };
    const before = JSON.stringify(response);

    const result = toTranscriptToolResult(response);

    expect(JSON.stringify(result.details)).toBe('{"__proto__":{"label":"kept","token":"***"}}');
    expect(Object.getPrototypeOf(result.details)).toBe(Object.prototype);
    expect(result.content).toEqual([
      {
        type: "text",
        text: expect.stringMatching(/^Authorization: Bearer .*\n(?:output ){1500}$/),
      },
      { type: "image", url: imageUrl },
    ]);
    expect(JSON.stringify(result)).not.toContain("abcdef0123456789QWERTY=");
    expect(JSON.stringify(response)).toBe(before);
  });
});
