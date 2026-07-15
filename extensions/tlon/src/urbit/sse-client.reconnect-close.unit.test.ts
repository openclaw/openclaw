import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { urbitFetch } from "./fetch.js";
import { UrbitSSEClient } from "./sse-client.js";

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  sleepWithAbort: vi.fn(
    (_delayMs: number, signal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  ),
}));

vi.mock("./fetch.js", () => ({
  urbitFetch: vi.fn(),
}));

vi.mock("./channel-ops.js", () => ({
  ensureUrbitChannelOpen: vi.fn().mockResolvedValue(undefined),
  pokeUrbitChannel: vi.fn().mockResolvedValue(undefined),
  scryUrbitPath: vi.fn().mockResolvedValue({}),
}));

describe("UrbitSSEClient extended reconnect backoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(urbitFetch).mockResolvedValue({
      response: new Response(null, { status: 204 }),
      finalUrl: "https://example.com",
      release: vi.fn().mockResolvedValue(undefined),
    });
  });

  it("cancels the max-attempt delay when the client closes", async () => {
    const onReconnect = vi.fn();
    const client = new UrbitSSEClient("https://example.com", "urbauth-~zod=123", {
      maxReconnectAttempts: 2,
      onReconnect,
    });
    client.reconnectAttempts = client.maxReconnectAttempts;

    const reconnect = client.attemptReconnect();
    expect(sleepWithAbort).toHaveBeenCalledWith(10_000, expect.any(AbortSignal));

    await client.close();
    await reconnect;

    expect(sleepWithAbort).toHaveBeenCalledTimes(1);
    expect(onReconnect).not.toHaveBeenCalled();
  });
});
