import { describe, expect, it } from "vitest";
import { extractToolErrorMessage } from "./pi-embedded-subscribe.tools.js";
import { sanitizeToolResult } from "./pi-embedded-subscribe.tools.js";

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

describe("sanitizeToolResult", () => {
  it("omits base64 data by default", () => {
    const input = {
      content: [{ type: "image", data: "AQID", mimeType: "image/png" }],
    };
    const sanitized = sanitizeToolResult(input) as {
      content?: Array<Record<string, unknown>>;
    };
    const item = sanitized.content?.[0] ?? {};
    expect(item.data).toBeUndefined();
    expect(item.omitted).toBe(true);
  });

  it("keeps base64 data when under limit", () => {
    const input = {
      content: [{ type: "image", data: "AQID", mimeType: "image/png" }],
    };
    const sanitized = sanitizeToolResult(input, { maxDataBytes: 10 }) as {
      content?: Array<Record<string, unknown>>;
    };
    const item = sanitized.content?.[0] ?? {};
    expect(item.data).toBe("AQID");
    expect(item.bytes).toBeUndefined();
    expect(item.omitted).toBeUndefined();
  });

  it("omits base64 data when over limit", () => {
    const input = {
      content: [{ type: "image", data: "AQID", mimeType: "image/png" }],
    };
    const sanitized = sanitizeToolResult(input, { maxDataBytes: 2 }) as {
      content?: Array<Record<string, unknown>>;
    };
    const item = sanitized.content?.[0] ?? {};
    expect(item.data).toBeUndefined();
    expect(item.omitted).toBe(true);
  });
});
