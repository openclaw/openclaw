import { describe, expect, it } from "vitest";
import {
  buildToolLifecycleErrorResult,
  extractToolResultText,
  extractToolErrorCode,
  extractToolErrorMessage,
  sanitizeToolArgs,
  sanitizeToolResult,
} from "./embedded-agent-tool-results.js";
import { isToolResultError } from "./tool-result-error.js";

it("preserves redacted own JSON fields in args", () => {
  const input = JSON.parse(
    '{"__proto__":{"label":"kept","token":"fixture-value"},"details":{"__proto__":null}}',
  );
  const before = JSON.stringify(input);
  const result = sanitizeToolArgs(input) as Record<string, unknown>;
  expect(JSON.stringify(result)).toBe(
    '{"__proto__":{"label":"kept","token":"***"},"details":{"__proto__":null}}',
  );
  expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  expect(Object.getPrototypeOf(result.details)).toBe(Object.prototype);
  expect(JSON.stringify(input)).toBe(before);
});

describe("tool errors", () => {
  it("ignores non-error status values", () => {
    expect(extractToolErrorMessage({ details: { status: "0" } })).toBeUndefined();
    expect(extractToolErrorMessage({ details: { status: "completed" } })).toBeUndefined();
    expect(extractToolErrorMessage({ details: { status: "ok" } })).toBeUndefined();
  });

  it("keeps error-like status values", () => {
    expect(extractToolErrorMessage({ details: { status: "failed" } })).toBe("failed");
    expect(extractToolErrorMessage({ details: { status: "timeout" } })).toBe("timeout");
    expect(
      extractToolErrorMessage({
        content: [{ type: "text", text: "Approval is unavailable." }],
        details: { status: "approval-unavailable" },
      }),
    ).toBe("Approval is unavailable.");
  });

  it("prefers node-host aggregated denial text over generic failed status", () => {
    expect(
      extractToolErrorMessage({
        content: [{ type: "text", text: "SYSTEM_RUN_DENIED: approval required" }],
        details: { status: "failed", aggregated: "SYSTEM_RUN_DENIED: approval required" },
      }),
    ).toBe("SYSTEM_RUN_DENIED: approval required");
  });

  it("does not promote prose-only denial output ahead of generic failed status", () => {
    expect(
      extractToolErrorMessage({
        content: [{ type: "text", text: "SYSTEM_RUN_DENIED: approval required" }],
        details: { status: "failed" },
      }),
    ).toBe("failed");
  });

  it("extracts structured tool error codes after sanitization", () => {
    expect(
      extractToolErrorCode(
        sanitizeToolResult({
          details: {
            status: "failed",
            error: { code: "SYSTEM_RUN_DENIED", message: "approval required" },
          },
        }),
      ),
    ).toBe("SYSTEM_RUN_DENIED");
    expect(
      extractToolErrorCode(
        sanitizeToolResult({
          details: {
            status: "failed",
            gatewayCode: "UNAVAILABLE",
            nodeError: { code: "UNAVAILABLE", message: "SYSTEM_RUN_DENIED: approval required" },
          },
        }),
      ),
    ).toBe("SYSTEM_RUN_DENIED");
    expect(
      extractToolErrorCode(
        sanitizeToolResult({
          details: {
            status: "failed",
            nodeError: { code: "INVALID_REQUEST", message: "approval expired" },
          },
        }),
      ),
    ).toBe("INVALID_REQUEST");
  });

  it("preserves direct structured tool error codes through sanitization", () => {
    const detailsCode = sanitizeToolResult({
      details: { status: "failed", code: "output_limit_exceeded" },
    });
    const rootCode = sanitizeToolResult({ status: "failed", code: "output_limit_exceeded" });
    expect(detailsCode).toEqual({ details: { status: "failed", code: "output_limit_exceeded" } });
    expect(rootCode).toEqual({ status: "failed", code: "output_limit_exceeded" });
    expect(extractToolErrorCode(detailsCode)).toBe("output_limit_exceeded");
    expect(extractToolErrorCode(rootCode)).toBe("output_limit_exceeded");
  });

  it("extracts structured node invoke failure codes after sanitization", () => {
    const result = sanitizeToolResult({
      details: {
        status: "failed",
        nodeInvokeFailure: {
          failureCode: "SYSTEM_RUN_DENIED",
          message: "execution denied by node policy",
        },
      },
    });

    expect(extractToolErrorCode(result)).toBe("SYSTEM_RUN_DENIED");
  });

  it("prefers a structured node denial over its Gateway unavailable wrapper", () => {
    const result = sanitizeToolResult({
      details: {
        status: "failed",
        reason: "outcome-unknown",
        nodeInvokeFailure: {
          failureCode: "UNAVAILABLE",
          message: "SYSTEM_RUN_DENIED: node policy denied proof command",
        },
      },
    });

    expect(extractToolErrorCode(result)).toBe("SYSTEM_RUN_DENIED");
    expect(extractToolErrorMessage(result)).toBe(
      "SYSTEM_RUN_DENIED: node policy denied proof command",
    );
  });

  it("does not extract error codes from prose-only tool output", () => {
    expect(
      extractToolErrorCode({
        content: [{ type: "text", text: "SYSTEM_RUN_DENIED: approval required" }],
        details: { status: "failed" },
      }),
    ).toBeUndefined();
    expect(
      extractToolErrorCode({
        details: { status: "failed", error: "SYSTEM_RUN_DENIED: approval required" },
      }),
    ).toBeUndefined();
  });

  it("preserves structured codes from thrown gateway errors", () => {
    const error = Object.assign(new Error("UNAVAILABLE: SYSTEM_RUN_DENIED: approval required"), {
      gatewayCode: "UNAVAILABLE",
      details: {
        nodeError: { code: "UNAVAILABLE", message: "SYSTEM_RUN_DENIED: approval required" },
      },
    });
    const result = buildToolLifecycleErrorResult(error);
    expect(extractToolErrorCode(result)).toBe("SYSTEM_RUN_DENIED");
    expect(extractToolErrorMessage(result)).toBe(
      "UNAVAILABLE: SYSTEM_RUN_DENIED: approval required",
    );
  });
});

describe("tool sanitization", () => {
  it.each(["text", "image"])("preserves own JSON fields when cleaning %s blocks", (type) => {
    const input = JSON.parse(
      '{"content":[{"__proto__":{"label":"kept","token":"fixture-value"},"text":"ordinary","data":"AA=="}]}',
    );
    input.content[0].type = type;
    const before = JSON.stringify(input);
    const result = sanitizeToolResult(input) as typeof input;
    expect(Object.hasOwn(result.content[0], "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(result.content[0])).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(result.content[0], "__proto__")?.value).toEqual({
      label: "kept",
      token: "***",
    });
    expect(JSON.stringify(input)).toBe(before);
  });

  it("reports decoded byte size when stripping image content", () => {
    const data = Buffer.from([0, 1, 2, 3, 4]).toString("base64");
    expect(
      sanitizeToolResult({ content: [{ type: "image", data, mimeType: "image/png" }] }),
    ).toEqual({
      content: [{ type: "image", mimeType: "image/png", bytes: 5, omitted: true }],
    });
  });

  it("preserves an existing image byte size when data is already omitted", () => {
    const result = { content: [{ type: "image", mimeType: "image/png", bytes: 5, omitted: true }] };
    expect(sanitizeToolResult(result)).toEqual(result);
  });

  it("redacts primitive string results without corrupting source assignments", () => {
    const sanitized = sanitizeToolResult("OPENROUTER_API_KEY=sk-or-v1-abcdef0123456789");
    expect(sanitized).not.toContain("sk-or-v1-abcdef0123456789");
    expect(sanitized).toContain("OPENROUTER_API_KEY=");
    expect(sanitizeToolResult("if let token = timeObserverToken {")).toBe(
      "if let token = timeObserverToken {",
    );
  });

  it("preserves top-level arrays while redacting nested strings", () => {
    const sanitized = sanitizeToolResult([
      { output: "Authorization: Bearer abcdef0123456789QWERTY=" },
      "apiKey=sk-1234567890abcdefXYZ",
    ]);
    expect(Array.isArray(sanitized)).toBe(true);
    expect(JSON.stringify(sanitized)).not.toContain("abcdef0123456789QWERTY=");
    expect(JSON.stringify(sanitized)).not.toContain("sk-1234567890abcdefXYZ");
    expect(sanitized).toEqual([
      { output: expect.stringContaining("Authorization: Bearer") },
      expect.any(String),
    ]);
  });

  it("redacts string-valued credentials nested anywhere in args", () => {
    const sanitized = sanitizeToolArgs({
      apiKey: "sk-1234567890abcdefXYZ",
      headers: { Authorization: "Bearer abcdef0123456789QWERTY=" },
      command: "OPENROUTER_API_KEY=sk-or-v1-abcdef0123456789 ./run.sh",
      flags: ["--api-key", "sk-1234567890abcdefXYZ"],
    });
    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain("sk-1234567890abcdefXYZ");
    expect(serialized).not.toContain("abcdef0123456789QWERTY=");
    expect(serialized).not.toContain("sk-or-v1-abcdef0123456789");
    expect(sanitized).toMatchObject({ flags: ["--api-key", expect.any(String)] });
  });
});

describe("extractToolResultText", () => {
  it("omits primitive inline data URI payloads", () => {
    const result = "data:text/plain;base64,abcdefghijklmnopqrstuvwxyz0123456789";
    expect(extractToolResultText(result)).toBe("[inline data URI: " + result.length + " chars]");
  });

  it("normalizes top-level CLI result arrays and objects", () => {
    expect(
      extractToolResultText([
        { type: "web_search_result", title: "OpenClaw", url: "https://example.com" },
      ]),
    ).toContain('"title":"OpenClaw"');
    expect(extractToolResultText([{ type: "text", text: "hello" }])).toBe("hello");
    expect(
      extractToolResultText({
        type: "web_search_tool_result_error",
        error_code: "unavailable",
      }),
    ).toContain('"error_code":"unavailable"');
    expect(
      extractToolResultText({
        type: "code_execution_result",
        content: [],
        return_code: 0,
        stderr: "",
        stdout: "command output",
      }),
    ).toContain('"stdout":"command output"');
  });

  it("suppresses MCP binary fields and structured secrets", () => {
    const text = extractToolResultText({
      content: [
        { type: "audio", data: "audio-base64-secret", mimeType: "audio/mpeg" },
        {
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: "document-base64-secret",
          },
        },
        {
          type: "resource",
          apiKey: "sk-structured-secret-1234567890",
          resource: {
            uri: "blob://result",
            blob: "resource-base64-secret",
            mimeType: "application/pdf",
          },
        },
      ],
    });
    expect(text).toContain('"uri":"blob://result"');
    expect(text).toContain('"blob":"[binary omitted:');
    expect(text).not.toContain("audio-base64-secret");
    expect(text).not.toContain("document-base64-secret");
    expect(text).not.toContain("resource-base64-secret");
    expect(text).not.toContain("sk-structured-secret-1234567890");
  });

  it("redacts structured headers and omits opaque CLI payloads before the output cap", () => {
    const text = extractToolResultText([
      {
        type: "web_search_result",
        encrypted_content: "opaque-search-ciphertext".repeat(500),
        encrypted_stdout: "opaque-command-ciphertext".repeat(500),
        apiKey: ["array-valued-api-secret"],
        headers: {
          cookie: ["session=structured-cookie-secret"],
          "set-cookie": ["sid=structured-set-cookie-secret; HttpOnly"],
        },
        title: "Useful result",
      },
    ]);
    expect(text).toContain('"encrypted_content":"[opaque data omitted:');
    expect(text).toContain('"encrypted_stdout":"[opaque data omitted:');
    expect(text).toContain('"title":"Useful result"');
    expect(text).not.toContain("opaque-search-ciphertext");
    expect(text).not.toContain("opaque-command-ciphertext");
    expect(text).not.toContain("array-valued-api-secret");
    expect(text).not.toContain("structured-cookie-secret");
    expect(text).not.toContain("structured-set-cookie-secret");
  });

  it("caps structured fallback output", () => {
    const text = extractToolResultText({ content: [{ type: "json", data: "x".repeat(9000) }] });
    expect(text).toContain("…(truncated)…");
    expect(text?.length).toBeLessThanOrEqual(8020);
  });
});

it("recognizes returned failures and nonzero exits", () => {
  expect(isToolResultError({ details: { status: "failed" } })).toBe(true);
  expect(isToolResultError({ details: { status: "blocked" } })).toBe(true);
  expect(isToolResultError({ details: { status: "approval-unavailable" } })).toBe(true);
  expect(isToolResultError({ details: { status: "completed", timedOut: true } })).toBe(true);
  expect(isToolResultError({ details: { status: "completed", exitCode: 1 } })).toBe(false);
  expect(isToolResultError({ details: { status: "completed", exitCode: 0 } })).toBe(false);
  expect(isToolResultError({ details: { exitCode: 1 } })).toBe(true);
  expect(isToolResultError({ details: { ok: true, status: "cancelled" } })).toBe(false);
  expect(isToolResultError({ details: { success: true, status: "canceled" } })).toBe(false);
  expect(isToolResultError({ details: { ok: false, status: "completed" } })).toBe(true);
  expect(isToolResultError({ details: { ok: true, status: "cancelled", timedOut: true } })).toBe(
    true,
  );
});
