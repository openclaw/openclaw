import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchDiscord } from "../api.js";
import { RequestClient } from "./rest.js";

const scope = vi.hoisted(() => ({ current: undefined as (() => void) | undefined }));
vi.mock("openclaw/plugin-sdk/fetch-runtime", async (original) => ({
  ...(await original<typeof import("openclaw/plugin-sdk/fetch-runtime")>()),
  captureChannelReadAuthority: () => scope.current,
}));

afterEach(() => {
  scope.current = undefined;
});

function authority() {
  let active = true;
  return {
    assert: () => {
      if (!active) {
        throw new Error("read authority revoked");
      }
    },
    revoke: () => {
      active = false;
    },
  };
}

describe("Discord read request authority", () => {
  it("retains the queued caller's authority when another caller drains the shared scheduler", async () => {
    const firstResponse = createDeferred<Response>();
    const fetch = vi
      .fn()
      .mockReturnValueOnce(firstResponse.promise)
      .mockResolvedValue(Response.json({ id: "other" }));
    const client = new RequestClient("synthetic-token", {
      fetch,
      scheduler: { maxConcurrency: 1 },
    });
    const first = client.get("/channels/100/messages");
    const reader = authority();
    scope.current = reader.assert;
    const queued = client.get("/channels/100/messages");
    const rejected = expect(queued).rejects.toThrow("read authority revoked");
    scope.current = undefined;
    reader.revoke();
    firstResponse.resolve(Response.json([]));
    await first;
    await rejected;
    expect(fetch).toHaveBeenCalledTimes(1);
    // Revoking the queued read must not poison ordinary traffic on the same client.
    await expect(client.get("/channels/100/messages")).resolves.toEqual({ id: "other" });
  });

  it("does not make the retry request after a rate-limit wait revokes authority", async () => {
    const reader = authority();
    const fetch = vi.fn(async () => {
      reader.revoke();
      scope.current = undefined;
      return Response.json(
        { retry_after: 0.001 },
        { status: 429, headers: { "retry-after": "0.001" } },
      );
    });
    const client = new RequestClient("synthetic-token", { fetch });
    scope.current = reader.assert;
    await expect(client.get("/channels/100/messages")).rejects.toThrow("read authority revoked");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("fences directory helper retries after authority is revoked", async () => {
    const reader = authority();
    const fetcher = vi.fn(async () => {
      reader.revoke();
      scope.current = undefined;
      return Response.json({ retry_after: 0.001 }, { status: 429 });
    });
    scope.current = reader.assert;
    await expect(
      fetchDiscord("/users/@me/guilds", "synthetic-token", fetcher, {
        retry: { attempts: 2, minDelayMs: 1, maxDelayMs: 1, jitter: 0 },
      }),
    ).rejects.toThrow("read authority revoked");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("checks unqueued requests before transport", async () => {
    const reader = authority();
    const fetch = vi.fn();
    const client = new RequestClient("synthetic-token", { fetch, queueRequests: false });
    scope.current = reader.assert;
    reader.revoke();
    await expect(client.get("/channels/100/messages")).rejects.toThrow("read authority revoked");
    expect(fetch).not.toHaveBeenCalled();
  });
});
