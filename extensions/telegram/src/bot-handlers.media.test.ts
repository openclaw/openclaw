// Telegram tests cover inbound media-error classification for ingress retry.
import { MediaFetchError } from "openclaw/plugin-sdk/media-runtime";
import { describe, expect, it } from "vitest";
import { isRecoverableMediaGroupError, isRetryableMediaFetchError } from "./bot-handlers.media.js";

describe("isRetryableMediaFetchError (#98076)", () => {
  it("treats network/abort fetch failures as durably retryable", () => {
    expect(
      isRetryableMediaFetchError(new MediaFetchError("fetch_failed", "connection reset")),
    ).toBe(true);
  });

  it("treats 408/429/5xx HTTP errors as durably retryable", () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      expect(
        isRetryableMediaFetchError(new MediaFetchError("http_error", `HTTP ${status}`, { status })),
      ).toBe(true);
    }
  });

  it("treats size limits and other 4xx HTTP errors as permanent", () => {
    expect(
      isRetryableMediaFetchError(new MediaFetchError("max_bytes", "exceeds maxBytes 999")),
    ).toBe(false);
    for (const status of [400, 401, 403, 404]) {
      expect(
        isRetryableMediaFetchError(new MediaFetchError("http_error", `HTTP ${status}`, { status })),
      ).toBe(false);
    }
  });

  it("treats http errors without a status as permanent", () => {
    expect(
      isRetryableMediaFetchError(new MediaFetchError("http_error", "bad content-length")),
    ).toBe(false);
  });

  it("never durably retries non-MediaFetchError values", () => {
    expect(isRetryableMediaFetchError(new Error("boom"))).toBe(false);
    expect(isRetryableMediaFetchError("nope")).toBe(false);
    expect(isRetryableMediaFetchError(undefined)).toBe(false);
  });
});

describe("isRecoverableMediaGroupError preserves album partial delivery (#55216)", () => {
  it("still skips-and-warns transient and permanent album fetch failures", () => {
    // Media groups intentionally skip the unfetchable photo and warn (#55216);
    // only the single-message path durably retries transient failures (#98076).
    expect(isRecoverableMediaGroupError(new MediaFetchError("fetch_failed", "x"))).toBe(true);
    expect(isRecoverableMediaGroupError(new MediaFetchError("max_bytes", "x"))).toBe(true);
  });
});
