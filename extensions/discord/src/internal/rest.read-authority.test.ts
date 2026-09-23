import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
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
});

type AuthorityKind = "read" | "action";

function authority(kind: AuthorityKind = "read") {
  let active = true;
  return {
    assert: () => {
      if (!active) {
        throw new Error(`${kind} authority revoked`);
      }
    },
    revoke: () => {
      active = false;
    },
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

function submitRequest(client: RequestClient, kind: AuthorityKind) {
  return kind === "read"
    ? client.get("/channels/100/messages")
    : client.put("/channels/100/pins/200");
}

describe("Discord request authority", () => {
  it.each([
    { name: "read", source: "read", companion: undefined },
    { name: "action", source: "action", companion: undefined },
    { name: "read with active action", source: "read", companion: "action" },
    { name: "action with active read", source: "action", companion: "read" },
  ] as const)(
    "retains queued $name authority on an injected shared client",
    async ({ source, companion }) => {
      const firstResponse = createDeferred<Response>();
      const fetch = vi
        .fn()
        .mockReturnValueOnce(firstResponse.promise)
        .mockResolvedValue(Response.json({ id: "other" }));
      const sharedClient = new RequestClient("synthetic-token", {
        fetch,
        scheduler: { maxConcurrency: 1 },
      });
      const { rest: client } = createDiscordRestClient({
        cfg: {},
        token: "synthetic-token",
        rest: sharedClient,
      });
      const first = sharedClient.get("/channels/100/messages");
      const caller = authority(source);
      const enqueue = () =>
        withAuthority(source, caller.assert, () => submitRequest(client, source));
      const queued = companion
        ? withAuthority(companion, authority(companion).assert, enqueue)
        : enqueue();
      const rejected = expect(queued).rejects.toThrow(`${source} authority revoked`);
      try {
        caller.revoke();
        firstResponse.resolve(Response.json([]));
        await first;
        await rejected;
        expect(fetch).toHaveBeenCalledTimes(1);
        // The revoked caller must not poison ordinary traffic on the same client.
        await expect(client.put("/channels/100/pins/200")).resolves.toEqual({ id: "other" });
      } finally {
        firstResponse.resolve(Response.json([]));
        await Promise.allSettled([first, queued, rejected]);
      }
    },
  );

  it.each(["read", "action"] as const)(
    "passes queued %s authority through asynchronous transport preparation",
    async (source) => {
      const firstResponse = createDeferred<Response>();
      const caller = authority(source);
      const transport = vi.fn();
      const fetch = vi
        .fn(
          async (
            _input: string | URL | Request,
            _init?: RequestInit,
            beforeRequest?: () => void,
          ) => {
            caller.revoke();
            await Promise.resolve();
            beforeRequest?.();
            transport();
            return Response.json([]);
          },
        )
        .mockImplementationOnce(() => firstResponse.promise);
      const client = new RequestClient("synthetic-token", {
        fetch,
        scheduler: { maxConcurrency: 1 },
      });
      const first = client.get("/channels/100/messages");
      const queued = withAuthority(source, caller.assert, () => submitRequest(client, source));
      const rejected = expect(queued).rejects.toThrow(`${source} authority revoked`);
      try {
        scope.current = authority().assert;
        firstResponse.resolve(Response.json([]));
        await first;
        await rejected;
        expect(transport).not.toHaveBeenCalled();
      } finally {
        firstResponse.resolve(Response.json([]));
        await Promise.allSettled([first, queued, rejected]);
      }
    },
  );

  it.each(["read", "action"] as const)(
    "does not retry %s requests after rate-limit revocation",
    async (source) => {
      const caller = authority(source);
      const fetch = vi.fn(async () => {
        caller.revoke();
        return Response.json(
          { retry_after: 0.001 },
          { status: 429, headers: { "retry-after": "0.001" } },
        );
      });
      const client = new RequestClient("synthetic-token", { fetch });
      await expect(
        withAuthority(source, caller.assert, () => submitRequest(client, source)),
      ).rejects.toThrow(`${source} authority revoked`);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("settles an already-dispatched PUT after source authority closes", async () => {
    const source = new AbortController();
    const dispatched = createDeferred<void>();
    const response = createDeferred<Response>();
    let requestSignal: AbortSignal | null | undefined;
    const fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal;
      dispatched.resolve();
      return response.promise;
    });
    const client = new RequestClient("synthetic-token", { fetch });
    const assertCurrent = () => source.signal.throwIfAborted();
    const pending = withDiscordRequestAuthority(assertCurrent, () =>
      client.put("/channels/100/pins/200"),
    );
    try {
      await Promise.race([dispatched.promise, pending]);
      source.abort(new Error("action authority revoked"));
      expect(requestSignal?.aborted).toBe(false);
      response.resolve(new Response(null, { status: 204 }));
      await expect(pending).resolves.toBeUndefined();
      await expect(
        withDiscordRequestAuthority(assertCurrent, () => client.put("/channels/100/pins/201")),
      ).rejects.toThrow("action authority revoked");
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      response.resolve(new Response(null, { status: 204 }));
      await Promise.allSettled([pending]);
    }
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

  it.each(["read", "action"] as const)(
    "checks unqueued %s requests before transport",
    async (source) => {
      const caller = authority(source);
      const fetch = vi.fn();
      const client = new RequestClient("synthetic-token", { fetch, queueRequests: false });
      caller.revoke();
      await expect(
        withAuthority(source, caller.assert, () => submitRequest(client, source)),
      ).rejects.toThrow(`${source} authority revoked`);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
