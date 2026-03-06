import { describe, expect, it } from "vitest";
import { callZaloApi, getUpdates, ZaloApiAbortError, ZaloApiError, type ZaloFetch } from "./api.js";

function createAbortableNeverFetch(): ZaloFetch {
  return async (_input, init) =>
    await new Promise<Response>((_resolve, reject) => {
      const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
      init?.signal?.addEventListener(
        "abort",
        () => {
          reject(abortError);
        },
        { once: true },
      );
    });
}

describe("zalo api abort handling", () => {
  it("maps local request timeout to ZaloApiAbortError(timeout)", async () => {
    await expect(
      callZaloApi("getMe", "token", undefined, {
        timeoutMs: 5,
        fetch: createAbortableNeverFetch(),
      }),
    ).rejects.toMatchObject({
      name: "ZaloApiAbortError",
      reason: "timeout",
    } satisfies Partial<ZaloApiAbortError>);
  });

  it("maps external abortSignal cancellation to ZaloApiAbortError(aborted)", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    await expect(
      callZaloApi(
        "getUpdates",
        "token",
        { timeout: "30" },
        {
          timeoutMs: 1000,
          abortSignal: controller.signal,
          fetch: createAbortableNeverFetch(),
        },
      ),
    ).rejects.toMatchObject({
      name: "ZaloApiAbortError",
      reason: "aborted",
    } satisfies Partial<ZaloApiAbortError>);
  });

  it("getUpdates accepts extended polling params and returns parsed response", async () => {
    const fetcher: ZaloFetch = async () =>
      new Response(
        JSON.stringify({
          ok: true,
          result: {
            event_name: "message.link.received",
          },
        }),
      );
    const response = await getUpdates("token", { timeout: 1, timeoutBufferMs: 50 }, fetcher);
    expect(response.ok).toBe(true);
    expect(response.result?.event_name).toBe("message.link.received");
  });

  it("maps HTML/non-JSON API responses to ZaloApiError with context", async () => {
    const fetcher: ZaloFetch = async () =>
      new Response("<html><h1>Bad gateway</h1></html>", {
        status: 502,
        headers: {
          "content-type": "text/html; charset=utf-8",
        },
      });

    await expect(
      callZaloApi("getUpdates", "token", undefined, { fetch: fetcher }),
    ).rejects.toMatchObject({
      name: "ZaloApiError",
      errorCode: 502,
    } satisfies Partial<ZaloApiError>);

    await expect(callZaloApi("getUpdates", "token", undefined, { fetch: fetcher })).rejects.toThrow(
      /non-JSON response/i,
    );
  });
});
