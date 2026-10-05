import { describe, expect, it } from "vitest";
import { isJsonObject, type JsonObject } from "./protocol.js";
import { toTranscriptToolResult } from "./run-attempt-tools.js";
import { sanitizeCodexToolArguments } from "./tool-progress-normalization.js";

describe("Codex tool progress payloads", () => {
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
      '{"__proto__":{"label":"kept","token":"fixture-value"},"nested":{"__proto__":null}}',
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
    if (!isJsonObject(result.details)) {
      throw new Error("expected JSON tool details");
    }

    expect(JSON.stringify(result.details)).toBe(
      '{"__proto__":{"label":"kept","token":"***"},"nested":{"__proto__":null}}',
    );
    expect(Object.getPrototypeOf(result.details)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(result.details.nested)).toBe(Object.prototype);
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
