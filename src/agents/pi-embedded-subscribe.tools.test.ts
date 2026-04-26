import { describe, expect, it } from "vitest";
import { extractToolErrorMessage, sanitizeToolResult } from "./pi-embedded-subscribe.tools.js";

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

  it("prefers node-host aggregated denial text over generic failed status", () => {
    expect(
      extractToolErrorMessage({
        content: [{ type: "text", text: "SYSTEM_RUN_DENIED: approval required" }],
        details: {
          status: "failed",
          aggregated: "SYSTEM_RUN_DENIED: approval required",
        },
      }),
    ).toBe("SYSTEM_RUN_DENIED: approval required");
  });

  it("uses result text before generic failed status when details omit aggregated output", () => {
    expect(
      extractToolErrorMessage({
        content: [{ type: "text", text: "SYSTEM_RUN_DENIED: approval required" }],
        details: { status: "failed" },
      }),
    ).toBe("SYSTEM_RUN_DENIED: approval required");
  });
});

function getTextContent(result: unknown, index = 0): string {
  const record = result as { content: Array<{ text: string }> };
  return record.content[index].text;
}

describe("sanitizeToolResult", () => {
  it("redacts JSON-style apiKey fields in text content blocks", () => {
    const result = {
      content: [
        {
          type: "text",
          text: '{"apiKey":"sk-1234567890abcdef","model":"gpt-4"}',
        },
      ],
    };
    const text = getTextContent(sanitizeToolResult(result));
    expect(text).not.toContain("sk-1234567890abcdef");
    expect(text).toContain("model");
  });

  it("redacts ENV-style credential assignments", () => {
    const result = {
      content: [
        {
          type: "text",
          text: "OPENROUTER_API_KEY=sk-or-v1-abcdef0123456789\nMODEL=gpt-4",
        },
      ],
    };
    const text = getTextContent(sanitizeToolResult(result));
    expect(text).not.toContain("sk-or-v1-abcdef0123456789");
    expect(text).toContain("MODEL=gpt-4");
  });

  it("redacts bare common-prefix tokens", () => {
    const result = {
      content: [{ type: "text", text: "token: sk-1234567890abcdef ghp_abcdefghij1234567890" }],
    };
    const text = getTextContent(sanitizeToolResult(result));
    expect(text).not.toContain("sk-1234567890abcdef");
    expect(text).not.toContain("ghp_abcdefghij1234567890");
  });

  it("redacts Bearer authorization tokens", () => {
    const result = {
      content: [{ type: "text", text: "Authorization: Bearer abcdef0123456789QWERTY=" }],
    };
    const text = getTextContent(sanitizeToolResult(result));
    expect(text).not.toContain("abcdef0123456789QWERTY=");
  });

  it("passes through non-sensitive text unchanged", () => {
    const result = {
      content: [{ type: "text", text: "hello world" }],
    };
    expect(getTextContent(sanitizeToolResult(result))).toBe("hello world");
  });

  it("preserves image content stripping behavior", () => {
    const result = {
      content: [{ type: "image", data: "base64imagedata", mimeType: "image/png" }],
    };
    const sanitized = sanitizeToolResult(result) as {
      content: Array<{ data?: string; bytes?: number; omitted?: boolean }>;
    };
    expect(sanitized.content[0].data).toBeUndefined();
    expect(sanitized.content[0].omitted).toBe(true);
    expect(sanitized.content[0].bytes).toBe("base64imagedata".length);
  });
});
