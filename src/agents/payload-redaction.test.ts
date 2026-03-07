import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { REDACTED_IMAGE_DATA, redactImageDataForDiagnostics } from "./payload-redaction.js";

describe("redactImageDataForDiagnostics", () => {
  it("passes through null and primitive values unchanged", () => {
    expect(redactImageDataForDiagnostics(null)).toBeNull();
    expect(redactImageDataForDiagnostics(42)).toBe(42);
    expect(redactImageDataForDiagnostics("hello")).toBe("hello");
    expect(redactImageDataForDiagnostics(true)).toBe(true);
  });

  it("passes through objects with no image data unchanged", () => {
    const input = { role: "user", content: "hello" };
    expect(redactImageDataForDiagnostics(input)).toEqual(input);
  });

  it("redacts image data identified by type field", () => {
    const data = "QUJDRA==";
    const result = redactImageDataForDiagnostics({
      type: "image",
      data,
    }) as Record<string, unknown>;
    expect(result.data).toBe(REDACTED_IMAGE_DATA);
    expect(result.bytes).toBe(4);
    expect(result.sha256).toBe(crypto.createHash("sha256").update(data).digest("hex"));
  });

  it("redacts image data identified by mimeType field", () => {
    const data = "U0VDUkVU";
    const result = redactImageDataForDiagnostics({
      mimeType: "image/jpeg",
      data,
    }) as Record<string, unknown>;
    expect(result.data).toBe(REDACTED_IMAGE_DATA);
    expect(result.bytes).toBe(6);
  });

  it("redacts image data identified by media_type field", () => {
    const data = "QUJDRA==";
    const result = redactImageDataForDiagnostics({
      media_type: "image/png",
      data,
    }) as Record<string, unknown>;
    expect(result.data).toBe(REDACTED_IMAGE_DATA);
  });

  it("does not redact records with image type but no data field", () => {
    const input = { type: "image" };
    const result = redactImageDataForDiagnostics(input) as Record<string, unknown>;
    expect(result).not.toHaveProperty("sha256");
    expect(result).not.toHaveProperty("bytes");
  });

  it("recurses into arrays and nested objects", () => {
    const input = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { media_type: "image/png", data: "QUJDRA==" },
            },
          ],
        },
      ],
    };
    const result = redactImageDataForDiagnostics(input) as {
      messages: Array<{
        content: Array<{ source: Record<string, unknown> }>;
      }>;
    };
    expect(result.messages[0]?.content[0]?.source.data).toBe(REDACTED_IMAGE_DATA);
  });

  it("handles circular references without throwing", () => {
    const obj: Record<string, unknown> = { key: "value" };
    obj.self = obj;
    const result = redactImageDataForDiagnostics(obj) as Record<string, unknown>;
    expect(result.self).toBe("[Circular]");
    expect(result.key).toBe("value");
  });
});
