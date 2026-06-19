// Qqbot tests cover api-client plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../types.js";
import { ApiClient } from "./api-client.js";

function cancelTrackedResponse(
  text: string,
  init: ResponseInit,
): {
  response: Response;
  wasCanceled: () => boolean;
} {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
    },
    cancel() {
      canceled = true;
    },
  });
  return {
    response: new Response(stream, init),
    wasCanceled: () => canceled,
  };
}

describe("ApiClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("bounds error bodies without using response.text()", async () => {
    const tracked = cancelTrackedResponse(`${"qqbot api unavailable ".repeat(1024)}tail`, {
      status: 503,
      headers: { "content-type": "text/plain" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(tracked.response);

    const client = new ApiClient({ baseUrl: "https://qqbot.test" });

    let error: unknown;
    try {
      await client.request("token-1", "GET", "/v2/users/@me");
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ApiError);
    expect(String(error)).toContain("API Error [/v2/users/@me] HTTP 503");
    expect(String(error)).toContain("qqbot api unavailable");
    expect(String(error)).not.toContain("tail");
    expect(tracked.wasCanceled()).toBe(true);
    expect(textSpy).not.toHaveBeenCalled();
  });
});
