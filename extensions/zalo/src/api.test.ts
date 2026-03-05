import { describe, expect, it } from "vitest";
import { callZaloApi, ZaloApiError } from "./api.js";

describe("callZaloApi", () => {
  it("returns parsed data on success", async () => {
    const mockFetch = async () =>
      new Response(JSON.stringify({ ok: true, result: { id: "123" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    const data = await callZaloApi("getMe", "test-token", undefined, { fetch: mockFetch });
    expect(data.ok).toBe(true);
    expect(data.result).toEqual({ id: "123" });
  });

  it("throws ZaloApiError when response.ok is false (HTTP error)", async () => {
    const mockFetch = async () =>
      new Response("<html>Bad Gateway</html>", {
        status: 502,
        statusText: "Bad Gateway",
      });

    await expect(
      callZaloApi("getMe", "test-token", undefined, { fetch: mockFetch }),
    ).rejects.toThrow(ZaloApiError);
  });

  it("throws ZaloApiError when API returns ok: false", async () => {
    const mockFetch = async () =>
      new Response(JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    await expect(
      callZaloApi("getMe", "test-token", undefined, { fetch: mockFetch }),
    ).rejects.toThrow(ZaloApiError);
  });
});
