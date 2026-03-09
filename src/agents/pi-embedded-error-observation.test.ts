import { afterEach, describe, expect, it, vi } from "vitest";
import * as loggingConfigModule from "../logging/config.js";
import {
  buildApiErrorObservationFields,
  buildTextObservationFields,
} from "./pi-embedded-error-observation.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildApiErrorObservationFields", () => {
  it("redacts request ids and exposes stable hashes instead of raw payloads", () => {
    const observed = buildApiErrorObservationFields(
      '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_overload"}',
    );

    expect(observed).toMatchObject({
      rawErrorPreview: expect.stringContaining('"request_id":"sha256:'),
      rawErrorHash: expect.stringMatching(/^sha256:/),
      rawErrorFingerprint: expect.stringMatching(/^sha256:/),
      providerErrorType: "overloaded_error",
      providerErrorMessagePreview: "Overloaded",
      requestIdHash: expect.stringMatching(/^sha256:/),
    });
    expect(observed.rawErrorPreview).not.toContain("req_overload");
  });

  it("forces token redaction for observation previews", () => {
    const observed = buildApiErrorObservationFields(
      "Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz123456",
    );

    expect(observed.rawErrorPreview).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(observed.rawErrorPreview).toContain("sk-abc");
    expect(observed.rawErrorHash).toMatch(/^sha256:/);
  });

  it("redacts observation-only header and cookie formats", () => {
    const observed = buildApiErrorObservationFields(
      "x-api-key: sk-abcdefghijklmnopqrstuvwxyz123456 Cookie: session=abcdefghijklmnopqrstuvwxyz123456",
    );

    expect(observed.rawErrorPreview).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(observed.rawErrorPreview).toContain("x-api-key: ***");
    expect(observed.rawErrorPreview).toContain("Cookie: session=");
  });

  it("does not let cookie redaction consume unrelated fields on the same line", () => {
    const observed = buildApiErrorObservationFields(
      "Cookie: session=abcdefghijklmnopqrstuvwxyz123456 status=503 request_id=req_cookie",
    );

    expect(observed.rawErrorPreview).toContain("Cookie: session=");
    expect(observed.rawErrorPreview).toContain("status=503");
    expect(observed.rawErrorPreview).toContain("request_id=sha256:");
  });

  it("builds sanitized generic text observation fields", () => {
    const observed = buildTextObservationFields(
      '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_prev"}',
    );

    expect(observed).toMatchObject({
      textPreview: expect.stringContaining('"request_id":"sha256:'),
      textHash: expect.stringMatching(/^sha256:/),
      textFingerprint: expect.stringMatching(/^sha256:/),
      providerErrorType: "overloaded_error",
      providerErrorMessagePreview: "Overloaded",
      requestIdHash: expect.stringMatching(/^sha256:/),
    });
    expect(observed.textPreview).not.toContain("req_prev");
  });

  it("redacts request ids in formatted plain-text errors", () => {
    const observed = buildApiErrorObservationFields(
      "LLM error overloaded_error: Overloaded (request_id: req_plaintext_123)",
    );

    expect(observed).toMatchObject({
      rawErrorPreview: expect.stringContaining("request_id: sha256:"),
      rawErrorFingerprint: expect.stringMatching(/^sha256:/),
      requestIdHash: expect.stringMatching(/^sha256:/),
    });
    expect(observed.rawErrorPreview).not.toContain("req_plaintext_123");
  });

  it("keeps fingerprints stable across request ids for equivalent errors", () => {
    const first = buildApiErrorObservationFields(
      '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_001"}',
    );
    const second = buildApiErrorObservationFields(
      '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_002"}',
    );

    expect(first.rawErrorFingerprint).toBe(second.rawErrorFingerprint);
    expect(first.rawErrorHash).not.toBe(second.rawErrorHash);
  });

  it("truncates oversized raw and provider previews", () => {
    const longMessage = "X".repeat(260);
    const observed = buildApiErrorObservationFields(
      `{"type":"error","error":{"type":"server_error","message":"${longMessage}"},"request_id":"req_long"}`,
    );

    expect(observed.rawErrorPreview).toBeDefined();
    expect(observed.providerErrorMessagePreview).toBeDefined();
    expect(observed.rawErrorPreview?.length).toBeLessThanOrEqual(401);
    expect(observed.providerErrorMessagePreview?.length).toBeLessThanOrEqual(201);
    expect(observed.providerErrorMessagePreview?.endsWith("…")).toBe(true);
  });

  it("returns empty observation fields for empty input", () => {
    expect(buildApiErrorObservationFields(undefined)).toEqual({});
    expect(buildApiErrorObservationFields("")).toEqual({});
    expect(buildApiErrorObservationFields("   ")).toEqual({});
  });

  it("re-reads configured redact patterns on each call", () => {
    const readLoggingConfig = vi.spyOn(loggingConfigModule, "readLoggingConfig");
    readLoggingConfig.mockReturnValueOnce(undefined);
    readLoggingConfig.mockReturnValueOnce({
      redactPatterns: [String.raw`\bcustom-secret-[A-Za-z0-9]+\b`],
    });

    const first = buildApiErrorObservationFields("custom-secret-abc123");
    const second = buildApiErrorObservationFields("custom-secret-abc123");

    expect(first.rawErrorPreview).toContain("custom-secret-abc123");
    expect(second.rawErrorPreview).not.toContain("custom-secret-abc123");
    expect(second.rawErrorPreview).toContain("custom");
  });

  it("fails closed when observation sanitization throws", () => {
    vi.spyOn(loggingConfigModule, "readLoggingConfig").mockImplementation(() => {
      throw new Error("boom");
    });

    expect(buildApiErrorObservationFields("request_id=req_123")).toEqual({});
    expect(buildTextObservationFields("request_id=req_123")).toEqual({
      textPreview: undefined,
      textHash: undefined,
      textFingerprint: undefined,
      httpCode: undefined,
      providerErrorType: undefined,
      providerErrorMessagePreview: undefined,
      requestIdHash: undefined,
    });
  });

  it("ignores non-string configured redact patterns", () => {
    vi.spyOn(loggingConfigModule, "readLoggingConfig").mockReturnValue({
      redactPatterns: [
        123 as never,
        { bad: true } as never,
        String.raw`\bcustom-secret-[A-Za-z0-9]+\b`,
      ],
    });

    const observed = buildApiErrorObservationFields("custom-secret-abc123");

    expect(observed.rawErrorPreview).not.toContain("custom-secret-abc123");
    expect(observed.rawErrorPreview).toContain("custom");
  });
});
