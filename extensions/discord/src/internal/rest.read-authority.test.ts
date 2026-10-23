import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, expect, it, vi } from "vitest";
import { fetchDiscord } from "../api.js";
import { createDiscordRestClient } from "../client.js";
import { withDiscordRequestAuthority } from "./request-authority.js";
import { RequestClient } from "./rest.js";

const scope = vi.hoisted(() => ({ current: undefined as (() => void) | undefined }));
vi.mock("openclaw/plugin-sdk/fetch-runtime", async (original) => ({
  ...(await original<typeof import("openclaw/plugin-sdk/fetch-runtime")>()),
  captureChannelReadAuthority: () => scope.current,
}));

afterEach(() => {
  scope.current = undefined;
  vi.useRealTimers();
});

type AuthorityKind = "read" | "action";
const token = "synthetic-token";

function authority(kind: AuthorityKind = "read") {
  const source = new AbortController();
  const assert = () => source.signal.throwIfAborted();
  const run = <T>(callback: () => T) => withAuthority(kind, assert, callback);
  const method = kind === "read" ? "get" : "put";
  const path = kind === "read" ? "/channels/100/messages" : "/channels/100/pins/200";
  return {
    revoke: () => source.abort(new Error(`${kind} authority revoked`)),
    run,
    request: (client: RequestClient) => run(() => client[method](path)),
    rejected: (pending: Promise<unknown>) =>
      expect(pending).rejects.toThrow(`${kind} authority revoked`),
  };
}

function withAuthority<T>(kind: AuthorityKind, assertCurrent: () => void, run: () => T): T {
  if (kind === "action") {
    return withDiscordRequestAuthority(assertCurrent, run);
  }
  const inherited = scope.current;
  scope.current = assertCurrent;
  try {
    return run();
  } finally {
    scope.current = inherited;
  }
}

it.each([
  ["read", "action"],
  ["action", "read"],
] as const)("retains queued %s authority with active %s", async (source, companion) => {
  const releaseWorkers = createDeferred<void>();
  const fetch = vi.fn(async () => {
    if (fetch.mock.calls.length <= 4) {
      await releaseWorkers.promise;
    }
    return Response.json({ id: "other" });
  });
  const sharedClient = new RequestClient(token, { fetch });
  const { rest: client } = createDiscordRestClient({ cfg: {}, token, rest: sharedClient });
  const active = Array.from({ length: 4 }, (_, index) =>
    sharedClient.get(`/channels/blocked-${index}/messages`),
  );
  const caller = authority(source);
  const queued = authority(companion).run(() => caller.request(client));
  const rejected = caller.rejected(queued);
  try {
    caller.revoke();
    releaseWorkers.resolve();
    await Promise.all(active);
    await rejected;
    expect(fetch).toHaveBeenCalledTimes(4);
    // The revoked caller must not poison ordinary traffic on the same client.
    await expect(client.put("/channels/100/pins/200")).resolves.toEqual({ id: "other" });
  } finally {
    releaseWorkers.resolve();
    await Promise.allSettled([...active, queued, rejected]);
  }
});

it("passes read authority through asynchronous transport preparation", async () => {
  const caller = authority();
  const transport = vi.fn();
  const fetch = vi.fn(
    async (_input: string | URL | Request, _init?: RequestInit, beforeRequest?: () => void) => {
      caller.revoke();
      await Promise.resolve();
      beforeRequest?.();
      transport();
      return Response.json([]);
    },
  );
  const client = new RequestClient(token, { fetch });
  await caller.rejected(caller.request(client));
  expect(transport).not.toHaveBeenCalled();
});

it.each(["REST", "directory"])("fences %s retries after revocation", async (route) => {
  vi.useFakeTimers();
  const caller = authority();
  const fetch = vi.fn(async () => {
    caller.revoke();
    scope.current = undefined;
    const headers = route === "REST" ? { "retry-after": "0.001" } : undefined;
    return Response.json({ retry_after: 0.001 }, { status: 429, headers });
  });
  const rejected = caller.rejected(
    caller.run(() =>
      route === "REST"
        ? new RequestClient(token, { fetch }).get("/channels/100/messages")
        : fetchDiscord("/users/@me/guilds", token, fetch, {
            retry: { attempts: 2, minDelayMs: 1, maxDelayMs: 1, jitter: 0 },
          }),
    ),
  );
  await vi.runAllTimersAsync();
  await rejected;
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("settles an already-dispatched PUT after source authority closes", async () => {
  const caller = authority("action");
  const dispatched = createDeferred<void>();
  const response = createDeferred<Response>();
  const fetch = vi.fn((_input: string | URL | Request, _init?: RequestInit) => {
    dispatched.resolve();
    return response.promise;
  });
  const client = new RequestClient(token, { fetch });
  const pending = caller.request(client);
  try {
    await Promise.race([dispatched.promise, pending]);
    caller.revoke();
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    response.resolve(new Response(null, { status: 204 }));
    await expect(pending).resolves.toBeUndefined();
    await caller.rejected(caller.run(() => client.put("/channels/100/pins/201")));
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    response.resolve(new Response(null, { status: 204 }));
    await Promise.allSettled([pending]);
  }
});
