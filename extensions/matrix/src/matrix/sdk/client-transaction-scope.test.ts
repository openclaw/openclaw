import http from "node:http";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import { MatrixClient } from "../sdk.js";
import { withResolvedMatrixSendClient } from "../send/client.js";

const dns = vi.hoisted(() => ({
  calls: 0,
  beforeResolve: undefined as (() => Promise<void>) | undefined,
}));

vi.mock("./transport-runtime-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./transport-runtime-api.js")>();
  return {
    ...actual,
    resolvePinnedHostnameWithPolicy: async (
      ...args: Parameters<typeof actual.resolvePinnedHostnameWithPolicy>
    ) => {
      dns.calls += 1;
      await dns.beforeResolve?.();
      return await actual.resolvePinnedHostnameWithPolicy(...args);
    },
  };
});

type ScopeSendResult = { scope: string; eventId: string };
type Outcome = { value: ScopeSendResult | undefined; error: unknown };

function settle(promise: Promise<ScopeSendResult>): Promise<Outcome> {
  return promise.then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );
}

async function waitForBoundary(
  boundary: Promise<void>,
  result: Promise<Outcome>,
  label: string,
): Promise<void> {
  await Promise.race([
    boundary,
    result.then(({ error }) => {
      throw toErrorObject(error, `send settled before ${label}`);
    }),
  ]);
}

it("keeps a shared transaction identity lookup alive when its first sender cancels during DNS", async () => {
  const dnsEntered = createDeferred<void>();
  const resumeDns = createDeferred<void>();
  const secondJoined = createDeferred<void>();
  const firstCaller = new AbortController();
  const secondCaller = new AbortController();
  const cancellation = new Error("first identity caller canceled during DNS preparation");
  const abandonedRoom = "!abandoned:example.org";
  const currentRoom = "!current:example.org";
  const timelineRequests: string[] = [];
  const unexpectedRequests: string[] = [];
  let whoamiRequests = 0;
  const server = http.createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    response.setHeader("content-type", "application/json");
    request.resume();
    if (request.method === "GET" && path === "/_matrix/client/v3/account/whoami") {
      whoamiRequests += 1;
      response.end(JSON.stringify({ user_id: "@bot:example.org", device_id: "fixture" }));
    } else if (request.method === "GET" && path.includes("/state/m.room.encryption")) {
      response.statusCode = 404;
      response.end(JSON.stringify({ errcode: "M_NOT_FOUND", error: "unencrypted room" }));
    } else if (request.method === "PUT" && path.includes("/send/m.room.message/")) {
      timelineRequests.push(path);
      response.end(JSON.stringify({ event_id: "$current-accepted" }));
    } else {
      unexpectedRequests.push(`${request.method} ${path}`);
      response.statusCode = 400;
      response.end(
        JSON.stringify({ errcode: "M_UNRECOGNIZED", error: "unexpected fixture request" }),
      );
    }
  });
  let client: MatrixClient | undefined;
  let first: Promise<Outcome> | undefined;
  let second: Promise<Outcome> | undefined;
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("missing loopback address");
    }
    const resolvedClient = new MatrixClient(`http://127.0.0.1:${address.port}`, "fixture-token", {
      userId: "@bot:example.org",
      deviceId: "fixture",
      encryption: false,
      autoBootstrapCrypto: false,
      ssrfPolicy: { allowPrivateNetwork: true },
    });
    client = resolvedClient;
    const send = (
      signal: AbortSignal,
      roomId: string,
      onScopeRequested?: () => void,
    ): Promise<ScopeSendResult> =>
      withResolvedMatrixSendClient({ client: resolvedClient, cfg: {}, signal }, async (sender) => {
        const identity = sender.getTransactionScopeId();
        onScopeRequested?.();
        const scope = await identity;
        const eventId = await sender.sendMessage(roomId, {
          msgtype: "m.text",
          body: "identity caller",
        });
        return { scope, eventId };
      });

    // Hold the transport's real await resolvePinnedHostnameWithPolicy before the first whoami fetch.
    dns.calls = 0;
    dns.beforeResolve = async () => {
      dnsEntered.resolve();
      await resumeDns.promise;
    };
    first = settle(send(firstCaller.signal, abandonedRoom));
    await waitForBoundary(dnsEntered.promise, first, "identity DNS preparation");
    second = settle(send(secondCaller.signal, currentRoom, () => secondJoined.resolve()));
    await waitForBoundary(secondJoined.promise, second, "the second identity waiter");
    expect(dns.calls).toBe(1);
    expect(whoamiRequests).toBe(0);

    firstCaller.abort(cancellation);
    resumeDns.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.error).toMatchObject({
      message: expect.stringContaining(cancellation.message),
    });
    expect(secondResult.error).toBeUndefined();
    expect(secondResult.value).toMatchObject({ eventId: "$current-accepted" });
    expect(timelineRequests).toEqual([
      expect.stringContaining(`/rooms/${currentRoom}/send/m.room.message/`),
    ]);
    expect(whoamiRequests).toBe(1);
    expect(await resolvedClient.getTransactionScopeId()).toBe(secondResult.value?.scope);
    expect(whoamiRequests).toBe(1);
    expect(unexpectedRequests).toEqual([]);
  } finally {
    resumeDns.resolve();
    dns.beforeResolve = undefined;
    try {
      await Promise.all([first, second]);
    } finally {
      try {
        await client?.stopWithoutPersist();
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
      }
    }
  }
});
