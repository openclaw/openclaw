import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentsApiClient } from "./agentsapi-client.js";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock:
    vi.fn<typeof import("openclaw/plugin-sdk/ssrf-runtime").fetchWithSsrFGuard>(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  fetchWithSsrFGuardMock.mockReset();
  vi.useRealTimers();
});

describe("Agents API event submission retries", () => {
  it("retries a tool result with the same payload and key, then gives a new submission its own key", async () => {
    queueResponse(serverError(500));
    queueResponse(serverError(503));
    queueResponse(new Response(null, { status: 202 }));
    const client = createClient();
    const submit = () =>
      client.toolResult(
        "session-fixture",
        {
          type: "function_call",
          turn_id: "turn-fixture",
          call_id: "call-fixture",
          name: "lookup",
          arguments: {},
        },
        { success: true, output: "Saved result" },
        new AbortController().signal,
      );
    const result = expect(submit()).resolves.toBeUndefined();
    await vi.runAllTimersAsync();
    await result;

    const attempts = requests();
    expect(attempts).toHaveLength(3);
    const key = attempts[0]!.headers.get("Idempotency-Key");
    expect(key).toEqual(expect.any(String));
    expect(key).not.toBe("");
    expect(attempts.map((request) => request.headers.get("Idempotency-Key"))).toEqual([
      key,
      key,
      key,
    ]);
    const bodies = await Promise.all(attempts.map((request) => request.text()));
    expect(bodies[1]).toBe(bodies[0]);
    expect(bodies[2]).toBe(bodies[0]);

    queueResponse(new Response(null, { status: 202 }));
    await submit();
    expect(requests().at(-1)!.headers.get("Idempotency-Key")).not.toBe(key);
  });

  it("stops after three server failures and preserves the last API error", async () => {
    for (const status of [500, 502, 504]) {
      queueResponse(serverError(status));
    }
    const result = expect(
      createClient().message("session-fixture", "Hello", new AbortController().signal),
    ).rejects.toMatchObject({ status: 504, message: expect.stringContaining("Failure 504") });
    await vi.runAllTimersAsync();
    await result;
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(3);
  });

  it("returns HTTP 429 without retrying the submission", async () => {
    queueResponse(serverError(429));
    await expect(
      createClient().message("session-fixture", "Hello", new AbortController().signal),
    ).rejects.toMatchObject({ status: 429 });
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
  });

  it("honors the server's explicit instruction not to retry", async () => {
    queueResponse(serverError(500, { "x-should-retry": "false" }));
    await expect(
      createClient().message("session-fixture", "Hello", new AbortController().signal),
    ).rejects.toMatchObject({ status: 500 });
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
  });

  it.each(["abort", "revoked ownership"])(
    "does not resend after %s during backoff",
    async (interruption) => {
      queueResponse(serverError(500));
      const controller = new AbortController();
      let current = true;
      const client = createClient(() => {
        if (!current) {
          throw new Error("Session ownership revoked");
        }
      });
      const result = expect(
        client.message("session-fixture", "Hello", controller.signal),
      ).rejects.toThrow(interruption === "abort" ? "aborted" : "Session ownership revoked");
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
      if (interruption === "abort") {
        controller.abort();
      } else {
        current = false;
      }
      await vi.runAllTimersAsync();
      await result;
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
    },
  );
});

function createClient(assertCurrent: () => void = () => {}) {
  return new AgentsApiClient("fixture-not-a-real-api-key", assertCurrent);
}

function serverError(status: number, headers?: HeadersInit) {
  return Response.json({ error: { message: `Failure ${status}` } }, { status, headers });
}

function queueResponse(response: Response) {
  fetchWithSsrFGuardMock.mockImplementationOnce(async (request) => {
    request.beforeRequest?.();
    return { response, finalUrl: request.url, release: async () => {} };
  });
}

function requests() {
  return fetchWithSsrFGuardMock.mock.calls.map(
    ([request]) => new Request(request.url, request.init),
  );
}
