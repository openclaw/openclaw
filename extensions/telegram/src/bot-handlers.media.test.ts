// Telegram tests cover inbound media-error classification for ingress retry.
import { MediaFetchError } from "openclaw/plugin-sdk/media-runtime";
import { describe, expect, it } from "vitest";
import { isRecoverableMediaGroupError } from "./bot-handlers.media.js";

describe("isRecoverableMediaGroupError preserves album partial delivery (#55216)", () => {
  it("still skips-and-warns transient and permanent album fetch failures", () => {
    // Media groups intentionally skip the unfetchable photo and warn (#55216);
    // only the single-message path durably retries transient failures (#98076,
    // via isDurablyRetryableMediaFetchError). Keep this path unchanged.
    expect(isRecoverableMediaGroupError(new MediaFetchError("fetch_failed", "x"))).toBe(true);
    expect(isRecoverableMediaGroupError(new MediaFetchError("max_bytes", "x"))).toBe(true);
  });
});
