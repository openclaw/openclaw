import { describe, expect, it } from "vitest";
import { redactImageDataForDiagnostics, sanitizeDiagnosticPayload } from "./payload-redaction.js";

describe("redactImageDataForDiagnostics", () => {
  it("returns primitives unchanged", () => {
    expect(redactImageDataForDiagnostics(null)).toBeNull();
    expect(redactImageDataForDiagnostics("string")).toBe("string");
    expect(redactImageDataForDiagnostics(42)).toBe(42);
    expect(redactImageDataForDiagnostics(true)).toBe(true);
  });

  it("handles arrays", () => {
    const result = redactImageDataForDiagnostics([1, "a", null]);
    expect(result).toEqual([1, "a", null]);
  });

  it("handles objects without image data", () => {
    const obj = { name: "test", value: 123 };
    expect(redactImageDataForDiagnostics(obj)).toEqual(obj);
  });

  it("handles nested objects", () => {
    const nested = { outer: { inner: { data: "text" } } };
    expect(redactImageDataForDiagnostics(nested)).toEqual(nested);
  });

  it("handles circular references", () => {
    const obj: any = { name: "test" };
    obj.self = obj;
    const result = redactImageDataForDiagnostics(obj);
    expect((result as any).self).toBe("[Circular]");
  });

  it("redacts image data with type=image", () => {
    const obj = { type: "image", data: "base64imagedata", mimeType: "image/png" };
    const result = redactImageDataForDiagnostics(obj) as any;
    expect(result.data).toBe("<redacted>");
    expect(result.sha256).toBeDefined();
    expect(result.bytes).toBeDefined();
  });

  it("redacts image data with mimeType starting image/", () => {
    const obj = { mimeType: "image/jpeg", data: "base64data" };
    const result = redactImageDataForDiagnostics(obj) as any;
    expect(result.data).toBe("<redacted>");
  });

  it("does not redact when data is not a string", () => {
    const obj = { type: "image", data: 123 };
    expect(redactImageDataForDiagnostics(obj)).toEqual(obj);
  });
});

describe("sanitizeDiagnosticPayload", () => {
  it("removes credential fields", () => {
    const obj = { apiKey: "secret", name: "test" };
    const result = sanitizeDiagnosticPayload(obj) as any;
    expect(result).not.toHaveProperty("apiKey");
    expect(result.name).toBe("test");
  });

  it("removes password fields", () => {
    const obj = { username: "user", password: "pass123" };
    const result = sanitizeDiagnosticPayload(obj) as any;
    expect(result.username).toBe("user");
    expect(result).not.toHaveProperty("password");
  });

  it("removes token fields", () => {
    const obj = { token: "abc", accessToken: "xyz" };
    const result = sanitizeDiagnosticPayload(obj) as any;
    expect(result).not.toHaveProperty("token");
    expect(result).not.toHaveProperty("accessToken");
  });

  it("preserves non-credential fields", () => {
    const obj = { name: "test", status: "active", count: 5 };
    const result = sanitizeDiagnosticPayload(obj) as any;
    expect(result.name).toBe("test");
    expect(result.status).toBe("active");
    expect(result.count).toBe(5);
  });

  it("handles authorization header", () => {
    const obj = { authorization: "Bearer token123", data: "test" };
    const result = sanitizeDiagnosticPayload(obj) as any;
    expect(result).not.toHaveProperty("authorization");
    expect(result.data).toBe("test");
  });

  it("combines sanitization with image redaction", () => {
    const obj = {
      apiKey: "secret",
      imageData: "base64",
      type: "image"
    };
    const result = sanitizeDiagnosticPayload(obj) as any;
    expect(result).not.toHaveProperty("apiKey");
    expect(result).not.toHaveProperty("imageData");
  });
});
