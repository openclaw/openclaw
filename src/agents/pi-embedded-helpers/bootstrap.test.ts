import { describe, expect, it } from "vitest";
import { buildBootstrapContextFiles } from "./bootstrap.js";
import { stripThoughtSignatures } from "./bootstrap.js";

describe("stripThoughtSignatures", () => {
  it("preserves thinkingSignature while still stripping invalid thought signatures", () => {
    const thinkingBlock = {
      type: "thinking",
      thinking: "internal",
      thinkingSignature: "keep_me",
      thoughtSignature: "msg_123",
    };
    const redactedBlock = {
      type: "redacted_thinking",
      redacted_thinking: "...",
      thinkingSignature: "keep_me_too",
      thoughtSignature: "msg_456",
    };
    const textBlock = {
      type: "text",
      text: "visible",
      thoughtSignature: "msg_789",
    };

    const result = stripThoughtSignatures([thinkingBlock, redactedBlock, textBlock], {
      includeCamelCase: true,
    });

    expect(result[0]).toEqual({
      type: "thinking",
      thinking: "internal",
      thinkingSignature: "keep_me",
    });
    expect(result[1]).toEqual({
      type: "redacted_thinking",
      redacted_thinking: "...",
      thinkingSignature: "keep_me_too",
    });
    expect(result[2]).toEqual({
      type: "text",
      text: "visible",
    });
  });
});

describe("buildBootstrapContextFiles edge cases", () => {
  it("survives undefined file.name without crashing (regression for #85523)", () => {
    const files = [
      {
        name: undefined,
        path: "/workspace/src/named-file.ts",
        content: "export const x = 1;",
        missing: false,
      },
    ];
    // Must not throw TypeError on undefined `name.toLowerCase()`.
    const result = buildBootstrapContextFiles(files as any);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(1);
    expect(result[0].content).toContain("export const x");
  });

  it("survives missing file.name and file.path (regression for #85523)", () => {
    const files = [
      {
        name: undefined,
        path: "",
        content: "nope",
        missing: false,
      },
    ];
    expect(() => buildBootstrapContextFiles(files as any)).not.toThrow();
  });
});
