import { describe, expect, it } from "vitest";
import {
  extractToolErrorMessage,
  sanitizeToolArgs,
  sanitizeToolResult,
} from "./pi-embedded-subscribe.tools.js";

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

  it("redacts Bearer authorization tokens", () => {
    const result = {
      content: [{ type: "text", text: "Authorization: Bearer abcdef0123456789QWERTY=" }],
    };
    const text = getTextContent(sanitizeToolResult(result));
    expect(text).not.toContain("abcdef0123456789QWERTY=");
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

  it("redacts secrets inside result.details (e.g. exec aggregated stdout)", () => {
    const result = {
      content: [{ type: "text", text: "ok" }],
      details: {
        status: "completed",
        aggregated:
          'OPENROUTER_API_KEY=sk-or-v1-abcdef0123456789\napiKey: "ghp_abcdefghij1234567890"',
        exitCode: 0,
        cwd: "/tmp/work",
      },
    };
    const sanitized = sanitizeToolResult(result) as {
      details: { status: string; aggregated: string; exitCode: number; cwd: string };
    };
    expect(sanitized.details.aggregated).not.toContain("sk-or-v1-abcdef0123456789");
    expect(sanitized.details.aggregated).not.toContain("ghp_abcdefghij1234567890");
    expect(sanitized.details.status).toBe("completed");
    expect(sanitized.details.exitCode).toBe(0);
    expect(sanitized.details.cwd).toBe("/tmp/work");
  });

  it("redacts a details-only result with no content array", () => {
    const result = {
      details: {
        config: { apiKey: "sk-1234567890abcdefXYZ", model: "gpt-4" },
      },
    };
    const sanitized = sanitizeToolResult(result) as {
      details: { config: { apiKey: string; model: string } };
    };
    expect(sanitized.details.config.apiKey).not.toContain("sk-1234567890abcdefXYZ");
    expect(sanitized.details.config.model).toBe("gpt-4");
  });
});

describe("sanitizeToolArgs", () => {
  it("redacts string-valued credentials nested anywhere in args", () => {
    const args = {
      apiKey: "sk-1234567890abcdefXYZ",
      headers: { Authorization: "Bearer abcdef0123456789QWERTY=" },
      command: "OPENROUTER_API_KEY=sk-or-v1-abcdef0123456789 ./run.sh",
      flags: ["--api-key", "sk-1234567890abcdefXYZ"],
    };
    const sanitized = sanitizeToolArgs(args) as {
      apiKey: string;
      headers: { Authorization: string };
      command: string;
      flags: string[];
    };
    expect(sanitized.apiKey).not.toContain("sk-1234567890abcdefXYZ");
    expect(sanitized.headers.Authorization).not.toContain("abcdef0123456789QWERTY=");
    expect(sanitized.command).not.toContain("sk-or-v1-abcdef0123456789");
    expect(sanitized.flags.join(" ")).not.toContain("sk-1234567890abcdefXYZ");
    expect(sanitized.flags[0]).toBe("--api-key");
  });

  it("passes through null/undefined and non-string primitives unchanged", () => {
    expect(sanitizeToolArgs(undefined)).toBeUndefined();
    expect(sanitizeToolArgs(null)).toBeNull();
    expect(sanitizeToolArgs(42)).toBe(42);
    expect(sanitizeToolArgs({ count: 3, file_path: "/tmp/x.txt" })).toEqual({
      count: 3,
      file_path: "/tmp/x.txt",
    });
  });
});
