import { describe, expect, it } from "vitest";
import { extractToolErrorMessage, isToolResultError } from "./pi-embedded-subscribe.tools.js";

describe("extractToolErrorMessage", () => {
  it("ignores non-error status values", () => {
    expect(extractToolErrorMessage({ details: { status: "0" } })).toBeUndefined();
    expect(extractToolErrorMessage({ details: { status: "completed" } })).toBeUndefined();
    expect(extractToolErrorMessage({ details: { status: "ok" } })).toBeUndefined();
  });

  it("keeps error-like status values", () => {
    expect(extractToolErrorMessage({ details: { status: "failed" } })).toBe("failed");
    expect(extractToolErrorMessage({ details: { status: "timeout" } })).toBe("timeout");
  });
});

describe("isToolResultError", () => {
  it("detects structured error payload in details", () => {
    expect(isToolResultError({ details: { status: "error", error: "boom" } })).toBe(true);
  });

  it("detects error payload encoded in text content", () => {
    expect(
      isToolResultError({
        content: [
          {
            type: "text",
            text: '{"status":"error","tool":"message","error":"Action send accepts a single destination."}',
          },
        ],
      }),
    ).toBe(true);
  });

  it("ignores successful text JSON payloads", () => {
    expect(
      isToolResultError({
        content: [{ type: "text", text: '{"status":"ok","ok":true}' }],
      }),
    ).toBe(false);
  });
});
