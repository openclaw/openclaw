import type { RequestListener } from "node:http";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { expect, it, vi } from "vitest";
import { MatrixClient } from "../sdk.js";
import { withResolvedMatrixSendClient } from "../send/client.js";

const dns = vi.hoisted(() => ({
  calls: 0,
  beforeResolve: undefined as (() => Promise<void>) | undefined,
}));

vi.mock("openclaw/plugin-sdk/ssrf-dispatcher", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-dispatcher")>();
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
  const handler: RequestListener = (request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    const respond = (body: object, statusCode = 200) => {
      response.writeHead(statusCode, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    request.resume();
    if (request.method === "GET" && path === "/_matrix/client/v3/account/whoami") {
      whoamiRequests += 1;
      respond({ user_id: "@bot:example.org", device_id: "fixture" });
    } else if (request.method === "GET" && path.includes("/state/m.room.encryption")) {
      respond({ errcode: "M_NOT_FOUND" }, 404);
    } else if (request.method === "PUT" && path.includes("/send/m.room.message/")) {
      timelineRequests.push(path);
      respond({ event_id: "$current-accepted" });
    } else {
      unexpectedRequests.push(`${request.method} ${path}`);
      respond({ errcode: "M_UNRECOGNIZED" }, 400);
    }
  };
  await withServer(handler, async (baseUrl) => {
    const client = new MatrixClient(baseUrl, "fixture-token", {
      userId: "@bot:example.org",
      deviceId: "fixture",
      encryption: false,
      autoBootstrapCrypto: false,
      ssrfPolicy: { allowPrivateNetwork: true },
    });
    let first: Promise<Outcome> | undefined;
    let second: Promise<Outcome> | undefined;
    try {
      const send = (
        signal: AbortSignal,
        roomId: string,
        onScopeRequested?: () => void,
      ): Promise<ScopeSendResult> =>
        withResolvedMatrixSendClient({ client, cfg: {}, signal }, async (sender) => {
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
      expect({ dns: dns.calls, whoami: whoamiRequests }).toEqual({ dns: 1, whoami: 0 });

      firstCaller.abort(cancellation);
      resumeDns.resolve();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult.error).toMatchObject({
        message: expect.stringContaining(cancellation.message),
      });
      expect(secondResult).toMatchObject({
        error: undefined,
        value: { eventId: "$current-accepted" },
      });
      expect(timelineRequests).toEqual([
        expect.stringContaining(`/rooms/${currentRoom}/send/m.room.message/`),
      ]);
      expect(whoamiRequests).toBe(1);
      expect(await client.getTransactionScopeId()).toBe(secondResult.value?.scope);
      expect(whoamiRequests).toBe(1);
      expect(unexpectedRequests).toEqual([]);
    } finally {
      resumeDns.resolve();
      dns.beforeResolve = undefined;
      try {
        await Promise.all([first, second]);
      } finally {
        await client.stopWithoutPersist();
      }
    }
  });
});
