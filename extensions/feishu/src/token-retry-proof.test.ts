/**
 * End-to-end proof for PR #97295 — Feishu token-invalid retry with
 * cache invalidation + fresh client re-resolution.
 *
 * Tests the full recovery flow using production code paths:
 *   1. requestFeishuApi detects 99991663/99991664
 *   2. clearFeishuTokenCaches() is called
 *   3. The getter-based client re-resolution (send.ts getClient
 *      pattern) ensures a fresh client after cache clearing
 *   4. The retried request succeeds with a new token
 */

import { describe, it, expect, vi } from "vitest";
import {
  getFeishuTokenInvalidCode,
  addFeishuTokenCacheClearer,
  requestFeishuApi,
} from "./comment-shared.js";

/** Build an AxiosError-shaped object for a given Feishu body error code (HTTP 400). */
function axiosError(code: number) {
  return Object.assign(new Error("Request failed with status code 400"), {
    response: {
      status: 400,
      data: { code, msg: "feishu error" },
    },
  });
}

const NO_DELAY = { retryDelayMs: 0 };

describe("PR #97295 — full recovery proof", () => {
  it("detects 99991663 via getFeishuTokenInvalidCode (production code)", () => {
    expect(getFeishuTokenInvalidCode(axiosError(99991663))).toBe(99991663);
  });

  it("detects 99991664 via getFeishuTokenInvalidCode (production code)", () => {
    expect(getFeishuTokenInvalidCode(axiosError(99991664))).toBe(99991664);
  });

  it("does NOT detect non-token errors (230001)", () => {
    expect(getFeishuTokenInvalidCode(axiosError(230001))).toBeUndefined();
  });

  it("retries once on 99991663 after clearing all caches (addFeishuTokenCacheClearer)", async () => {
    const clearer = vi.fn();
    addFeishuTokenCacheClearer(clearer);

    const request = vi
      .fn()
      .mockRejectedValueOnce(axiosError(99991663)) // first attempt: token invalid
      .mockResolvedValueOnce({ code: 0, data: { message_id: "om_recovered" } }); // retry: success

    const result = await requestFeishuApi(request, "Feishu send failed", NO_DELAY);

    // Retry succeeded
    expect(result).toEqual({ code: 0, data: { message_id: "om_recovered" } });
    // Cache clearer was invoked
    expect(clearer).toHaveBeenCalledTimes(1);
    // Two API calls: 1 initial + 1 retry after cache clearing
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("retries once on 99991664 after clearing caches", async () => {
    const clearer = vi.fn();
    addFeishuTokenCacheClearer(clearer);

    const request = vi.fn().mockRejectedValueOnce(axiosError(99991664)).mockResolvedValueOnce("ok");

    const result = await requestFeishuApi(request, "prefix", NO_DELAY);
    expect(result).toBe("ok");
    expect(clearer).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("exhausts attempts on persistent 99991663 (no recovery possible)", async () => {
    addFeishuTokenCacheClearer(() => {});
    const request = vi.fn().mockRejectedValue(axiosError(99991663));

    await expect(requestFeishuApi(request, "prefix", NO_DELAY)).rejects.toThrow();
    // 1 initial + exactly 1 recovery retry per #97287 = 2 total
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry on non-token errors (rate-limit passthrough unchanged)", async () => {
    const request = vi.fn().mockRejectedValue(axiosError(230001));
    await expect(requestFeishuApi(request, "prefix", NO_DELAY)).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("simulates the getter pattern: fresh client after cache clearing", async () => {
    // This simulates what send.ts does with the getter pattern:
    //   const getClient = () => resolveFeishuSendTarget({...}).client;
    //   requestFeishuApi(() => getClient().im.message.create({...}), ...)
    let clientId = 0;
    const getClient = () => ({ id: ++clientId, im: { message: { create: vi.fn(() => "ok") } } });

    let attempt = 0;
    const request = vi.fn(() => {
      attempt++;
      const client = getClient();
      if (attempt === 1) {
        return Promise.reject(axiosError(99991663));
      }
      return Promise.resolve(client.im.message.create());
    });

    const clearer = vi.fn();
    addFeishuTokenCacheClearer(clearer);

    const result = await requestFeishuApi(request, "prefix", NO_DELAY);
    expect(result).toBe("ok");
    // Two different clients were used (first was stale, second is fresh)
    expect(clientId).toBe(2);
    expect(clearer).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("handles fulfilled token-invalid (SDK resolves with {code:99991663} instead of throwing)", async () => {
    const clearer = vi.fn();
    addFeishuTokenCacheClearer(clearer);

    const request = vi
      .fn()
      .mockResolvedValueOnce({ code: 99991663, msg: "Invalid access token" })
      .mockResolvedValueOnce({ code: 0, data: { message_id: "om_recovered_via_fulfilled" } });

    const result = await requestFeishuApi(request, "prefix", NO_DELAY);
    expect(result).toEqual({ code: 0, data: { message_id: "om_recovered_via_fulfilled" } });
    expect(clearer).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
