// Qqbot tests cover api-client plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  };
});

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
    fetchWithSsrFGuardMock.mockReset();
  });

  it("bounds error bodies without using response.text()", async () => {
    const release = vi.fn(async () => {});
    const tracked = cancelTrackedResponse(`${"qqbot api unavailable ".repeat(1024)}tail`, {
      status: 503,
      headers: { "content-type": "text/plain" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: tracked.response,
      release,
    });

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
    expect(release).toHaveBeenCalledTimes(1);
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith({
      url: "https://qqbot.test/v2/users/@me",
      init: {
        method: "GET",
        headers: {
          Authorization: "QQBot token-1",
          "Content-Type": "application/json",
          "User-Agent": "QQBotPlugin/unknown",
        },
        signal: expect.any(AbortSignal),
      },
      auditContext: "qqbot-api",
      policy: {
        hostnameAllowlist: ["qqbot.test"],
        allowRfc2544BenchmarkRange: true,
      },
      timeoutMs: 30_000,
      capture: false,
    });
  });

  it("preserves timeout classification from guarded fetch timeouts", async () => {
    const timeout = new Error("request timed out");
    timeout.name = "TimeoutError";
    fetchWithSsrFGuardMock.mockRejectedValueOnce(timeout);

    const client = new ApiClient({ baseUrl: "https://qqbot.test", defaultTimeoutMs: 1234 });

    await expect(client.request("token-1", "GET", "/v2/users/@me")).rejects.toMatchObject({
      message: "Request timeout [/v2/users/@me]: exceeded 1234ms",
      httpStatus: 0,
      path: "/v2/users/@me",
    });
  });
});
