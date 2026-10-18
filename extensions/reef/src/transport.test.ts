import { createPublicKey, verify as verifySignature } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import { text } from "node:stream/consumers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { awaitGateBeforeSettlement } from "openclaw/plugin-sdk/test-fixtures";
import { WebSocket, WebSocketServer } from "openclaw/plugin-sdk/websocket-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { canonicalBytes, fromBase64url, sha256Hex } from "../protocol/index.js";
import {
  ReefInboxConnection,
  ReefProtocolCompatibilityError,
  ReefRelayError,
  createReefWebSocket,
  isRetryableReefRelayFailure,
} from "./transport.js";
import { createClient, signing, ts } from "./transport.test-helpers.js";
import type { RelayFriend } from "./types.js";

type EffectAuthority = ReturnType<
  typeof import("openclaw/plugin-sdk/fetch-runtime").captureEffectAuthority
>;
const effectInput = vi.hoisted(() => ({
  captureFailure: undefined as Error | undefined,
  current: undefined as EffectAuthority | undefined,
}));
vi.mock("openclaw/plugin-sdk/fetch-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/fetch-runtime")>();
  return {
    ...actual,
    captureEffectAuthority() {
      if (effectInput.captureFailure) {
        throw effectInput.captureFailure;
      }
      return effectInput.current ?? actual.captureEffectAuthority();
    },
  };
});

const pendingFriend: RelayFriend = {
  peer: "bob",
  status: "pending",
  initiated_by: "bob",
  vouching_mutual: null,
  ed25519_pub: "B".repeat(43),
  x25519_pub: "C".repeat(43),
  key_epoch: 2,
};
const activeFriend = { peer: "bob", status: "active" };

function recordingClient(body: unknown, status = 200) {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(body, { status }));
  return { client: createClient(fetcher), fetcher };
}

function expectFriendshipBody(init: RequestInit | undefined) {
  expect(JSON.parse(new TextDecoder().decode(init?.body as Uint8Array))).toEqual({
    peer: "bob",
    accept: true,
    expected_key_epoch: 2,
    expected_ed25519_pub: "B".repeat(43),
    expected_x25519_pub: "C".repeat(43),
  });
}

function expectRedacted(error: unknown, secrets: string[]) {
  expect(error).toMatchObject({
    name: "ReefRelayError",
    status: 401,
    message: expect.stringContaining("relay rejected"),
  });
  for (const secret of secrets) {
    expect((error as Error).message).not.toContain(secret);
  }
}

const closeServers: Array<() => Promise<void>> = [];
async function listen(server: http.Server | WebSocketServer) {
  const peers = new Set<import("node:net").Socket>();
  closeServers.push(async () => {
    peers.forEach((peer) => peer.destroy());
    if (server instanceof WebSocketServer) {
      server.clients.forEach((socket) => socket.terminate());
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
  if (server instanceof http.Server) {
    server.on("connection", (socket) => peers.add(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } else {
    await once(server, "listening");
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Reef test server did not bind a TCP port");
  }
  return address.port;
}

afterEach(async () => {
  effectInput.captureFailure = undefined;
  effectInput.current = undefined;
  await Promise.all(closeServers.splice(0).map((close) => close()));
});

it("rejects definitive relay and local failures", () => {
  expect(isRetryableReefRelayFailure(new ReefRelayError(401, "unauthorized"))).toBe(false);
  expect(isRetryableReefRelayFailure(new Error("approval store unavailable"))).toBe(false);
});

it.each(["capture", "peer"] as const)(
  "does not fetch after %s authority refusal",
  async (stage) => {
    const refusal = new Error(`${stage} authority refused`);
    let current = true;
    if (stage === "capture") {
      effectInput.captureFailure = refusal;
    } else {
      effectInput.current = {
        active: true,
        run: (run) => run(),
        async initiate(effect) {
          await Promise.resolve();
          current = false;
          return effect();
        },
      };
    }
    const fetcher = vi.fn<typeof fetch>();
    const recheck = () => {
      if (!current) {
        throw refusal;
      }
    };
    const client = createClient(fetcher);
    const completion =
      stage === "capture"
        ? client.listFriends()
        : client.signed("POST", "/v1/mail/bob", undefined, undefined, [], recheck);
    await expect(completion).rejects.toBe(refusal);
    expect(fetcher).not.toHaveBeenCalled();
    expect(isRetryableReefRelayFailure(refusal)).toBe(false);
  },
);

it.each([false, true])(
  "keeps authority refusal outside transport retries (allowed=%s)",
  async (allowed) => {
    const preparing = createDeferred<void>();
    const prepared = createDeferred<void>();
    const response = createDeferred<Response>();
    const requested = createDeferred<void>();
    const refusal = new Error("message use refused");
    let initiating = false;
    let handedOff = false;
    effectInput.current = {
      active: true,
      run: (run) => run(),
      async initiate(effect) {
        preparing.resolve();
        await prepared.promise;
        if (!allowed) {
          throw refusal;
        }
        initiating = true;
        try {
          return effect();
        } finally {
          initiating = false;
          handedOff = true;
        }
      },
    };
    const fetcher = vi.fn(() => {
      expect(initiating).toBe(true);
      requested.resolve();
      return response.promise;
    });
    const completion = createClient(fetcher).listFriends();
    try {
      await awaitGateBeforeSettlement(
        preparing.promise,
        Promise.race([completion, requested.promise]),
        "Fetch skipped preparation",
      );
      expect(fetcher).not.toHaveBeenCalled();
      prepared.resolve();
      if (!allowed) {
        await expect(completion).rejects.toBe(refusal);
        expect(isRetryableReefRelayFailure(refusal)).toBe(false);
        expect(fetcher).not.toHaveBeenCalled();
        return;
      }
      await awaitGateBeforeSettlement(requested.promise, completion, "Fetch was not initiated");
      expect(handedOff).toBe(true);
      response.resolve(Response.json({ friendships: [] }));
      await expect(completion).resolves.toEqual({ friendships: [] });
    } finally {
      prepared.resolve();
      response.resolve(Response.json({ friendships: [] }));
      await completion.catch(() => {});
    }
  },
);

it("normalizes connection loss while reading a successful response body", async () => {
  const cause = new TypeError("terminated");
  const response = new Response(
    new ReadableStream({ start: (controller) => controller.error(cause) }),
  );
  await expect(createClient(async () => response).listFriends()).rejects.toMatchObject({
    name: "ReefRelayUnavailableError",
    message: "terminated",
    cause,
  });
});
function verifyRelaySignature(signature: string, path: string): boolean {
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  const publicKey = createPublicKey({
    key: Buffer.concat([spkiPrefix, Buffer.from(fromBase64url(signing.publicKey))]),
    format: "der",
    type: "spki",
  });
  return verifySignature(
    null,
    canonicalBytes({ method: "GET", path, ts, bodySha256: sha256Hex(new Uint8Array()) }),
    publicKey,
    Buffer.from(fromBase64url(signature)),
  );
}

it("signs the relay canonical REST path including its query and emits auth headers", async () => {
  const { client, fetcher } = recordingClient({ entries: [], cursor: 5 });

  await expect(client.pull(5)).resolves.toEqual({ entries: [], cursor: 5 });

  const [requestUrl, init] = fetcher.mock.calls[0]!;
  expect(requestUrl instanceof URL ? requestUrl.href : requestUrl).toBe(
    "https://relay.example/v1/mail?after=5",
  );
  expect(init?.method).toBe("GET");
  const headers = new Headers(init?.headers);
  expect(Object.fromEntries(headers)).toMatchObject({
    "x-reef-handle": "alice",
    "x-reef-ts": String(ts),
    "x-reef-sig":
      "1Zx-WD8JygVzq8pdTWULPiEZyoLuoJ1zyokkDRGlPWu_6fAKxEfJHPZkCQaZ8DIS4LERDqeh2z6-qlw7BtcoDw",
  });

  expect(verifyRelaySignature(headers.get("x-reef-sig")!, "/v1/mail?after=5")).toBe(true);
});

it("puts WebSocket auth in the query but signs the bare relay path", () => {
  const url = new URL(createClient(vi.fn<typeof fetch>()).websocketUrl());

  expect(url).toMatchObject({ protocol: "wss:", pathname: "/v1/mail/ws" });
  expect(Object.fromEntries(url.searchParams)).toEqual({
    handle: "alice",
    ts: String(ts),
    sig: "teC4QkpLUCMghGA-PkBGBMZFPxNeERmNfGCivaxpYhL8q81v6ReHRKEq2ZVvOd-FG3d3BbMjk-FcvoKjW5kwAA",
  });
  expect(verifyRelaySignature(url.searchParams.get("sig")!, "/v1/mail/ws")).toBe(true);
});

it("binds friendship responses to the exact listed peer key snapshot", async () => {
  const { client, fetcher } = recordingClient({ ...activeFriend, future: "ignored" });
  await expect(client.respondFriend(pendingFriend, true)).resolves.toEqual(activeFriend);
  expectFriendshipBody(fetcher.mock.calls[0]?.[1]);
});

it.each([
  [
    400,
    "invalid_request",
    "reef-relay",
    "The Reef relay is likely incompatible or outdated. Update OpenClaw and the Reef relay together, then approve the fresh pairing challenge again.",
  ],
  [
    409,
    "client_upgrade_required",
    "openclaw-client",
    "OpenClaw is outdated for this Reef relay. Update OpenClaw, then approve the fresh pairing challenge again.",
  ],
] as const)(
  "diagnoses HTTP %i compatibility failure without retrying or downgrading",
  async (status, code, upgradeRequired, message) => {
    const { client, fetcher } = recordingClient({ error: code }, status);
    const error = await client.respondFriend(pendingFriend, true).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ReefRelayError);
    expect(error).toBeInstanceOf(ReefProtocolCompatibilityError);
    expect(error).toMatchObject({ status, code, upgradeRequired, message });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expectFriendshipBody(fetcher.mock.calls[0]?.[1]);
  },
);

it.each([
  ["an empty 204", () => new Response(null, { status: 204 }), true],
  ["a different peer", () => Response.json({ peer: "mallory", status: "active" }), true],
  ["the wrong accepted status", () => Response.json({ peer: "bob", status: "blocked" }), true],
  ["the wrong rejected status", () => Response.json(activeFriend), false],
] as const)("rejects %s before friendship trust can be committed", async (_, response, accept) => {
  await expect(
    createClient(async () => response()).respondFriend(pendingFriend, accept),
  ).rejects.toThrow("invalid Reef relay friendship response");
});

it("bumps ts monotonically so identical same-second requests never share a replay key", async () => {
  const { client, fetcher } = recordingClient({ friendships: [] });

  await client.listFriends();
  await client.listFriends();
  await client.listFriends();

  const seenTs = fetcher.mock.calls.map(([, init]) => new Headers(init?.headers).get("x-reef-ts"));
  expect(seenTs).toEqual([String(ts), String(ts + 1), String(ts + 2)]);
});
const SUCCESS_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;

function createTrackedResponse(status: number, sizes: number[]) {
  const state = { emittedBytes: 0, cancelled: false };
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const size = sizes[index++];
      if (size === undefined) {
        controller.close();
        return;
      }
      state.emittedBytes += size;
      controller.enqueue(new Uint8Array(size).fill(0x78));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return {
    response: new Response(body, { status, headers: { "content-type": "application/json" } }),
    state,
  };
}

it("cancels success JSON when a chunk crosses the byte limit", async () => {
  const offered = createTrackedResponse(200, [SUCCESS_RESPONSE_MAX_BYTES - 1, 2, 1024, 1024]);
  const client = createClient(async () => offered.response);

  await expect(client.pull(0)).rejects.toThrow(/reef\.relay: JSON response exceeds 16777216 bytes/);
  expect(offered.state.cancelled).toBe(true);
  expect(offered.state.emittedBytes).toBeGreaterThan(SUCCESS_RESPONSE_MAX_BYTES);
  expect(offered.state.emittedBytes).toBeLessThan(SUCCESS_RESPONSE_MAX_BYTES + 1 + 2048);
});

it("keeps status fallback and cancels oversized error bodies", async () => {
  const offered = createTrackedResponse(503, Array<number>(16).fill(8 * 1024));
  const client = createClient(async () => offered.response);

  await expect(client.listFriends()).rejects.toMatchObject({
    name: "ReefRelayError",
    status: 503,
    message: "relay HTTP 503",
    code: undefined,
  });
  expect(offered.state.cancelled).toBe(true);
  expect(offered.state.emittedBytes).toBeGreaterThan(64 * 1024);
  expect(offered.state.emittedBytes).toBeLessThan(128 * 1024);
});

it("keeps the status fallback when parsed error JSON has no relay code", async () => {
  const client = createClient(async () => Response.json({ detail: "ignored" }, { status: 400 }));

  await expect(client.requestFriend("bob")).rejects.toMatchObject({
    name: "ReefRelayError",
    status: 400,
    message: "relay HTTP 400",
    code: undefined,
  });
});
it("redacts setup tokens and bearer sessions from loopback relay errors", async () => {
  const setupToken = "reef.token[abc]+?/";
  const session = `reef-session-${"a".repeat(96)}-tail`;
  const receivedAuthorization: string[] = [];
  const receivedSignatures: string[] = [];
  const receivedTokens: string[] = [];
  const server = http.createServer(async (request, response) => {
    const body = await text(request);
    const authorization = request.headers.authorization ?? "";
    receivedAuthorization.push(authorization);
    const signature = String(request.headers["x-reef-sig"] ?? "");
    if (signature) {
      receivedSignatures.push(signature);
    }
    const token = body ? (JSON.parse(body) as { token?: string }).token : undefined;
    if (token) {
      receivedTokens.push(token);
    }
    const reflectedCredential = authorization || token || signature;
    response.writeHead(401, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ error: `${reflectedCredential} relay rejected`, marker: "safe" }),
    );
  });
  const port = await listen(server);
  const client = createClient(fetch, () => ts, `http://127.0.0.1:${port}`);
  expectRedacted(await client.authComplete(setupToken).catch((error: unknown) => error), [
    setupToken,
  ]);
  const sessionSecrets = [session, session.slice(0, 6), session.slice(-4)];
  for (const request of [
    () => client.createHandle(session, "approve"),
    () => client.listOwnHandles(session),
  ]) {
    expectRedacted(await request().catch((error: unknown) => error), sessionSecrets);
  }
  const signedError = await client.listFriends().catch((error: unknown) => error);
  expect(receivedAuthorization).toContain(`Bearer ${session}`);
  expect(receivedSignatures).toHaveLength(1);
  expectRedacted(signedError, [receivedSignatures[0]!]);
  expect(receivedTokens).toContain(setupToken);
});

it("redacts signed body credentials across bounded error text", async () => {
  const code = "friend.code[123]+?/";
  const receivedBodies: string[] = [];
  const client = createClient(async (_url, init) => {
    receivedBodies.push(await new Response(init?.body).text());
    const responseBody = JSON.stringify({
      error: `${"x".repeat(32_760)}${code}${"y".repeat(32)}`,
    });
    const splitAt = responseBody.indexOf(code) + Math.floor(code.length / 2);
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const part of [responseBody.slice(0, splitAt), responseBody.slice(splitAt)]) {
            controller.enqueue(new TextEncoder().encode(part));
          }
          controller.close();
        },
      }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  });

  const error = await client.requestFriend("bob", code).catch((failure: unknown) => failure);

  expect(error).toMatchObject({ name: "ReefRelayError", status: 401 });
  expect(receivedBodies).toHaveLength(1);
  expect(receivedBodies[0]).toContain(`"code":"${code}"`);
  expect((error as Error).message).not.toContain(code);
});
it("rejects a relay frame above the payload limit before dispatch", async () => {
  const bytes = 64 * 1024 + 1;
  const prefix =
    '{"type":"entry","entry":{"seq":1,"peer":"bob","id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","kind":"receipt","receipt":{"pad":"';
  const suffix = '"},"ts":1752300000}}';
  const frame = `${prefix}${"x".repeat(bytes - prefix.length - suffix.length)}${suffix}`;
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const port = await listen(server);
  const entries: unknown[] = [];
  const states: string[] = [];
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 2_000);
  server.once("connection", (socket) => socket.send(frame));
  const client = createClient(
    async () => Response.json({ entries: [], cursor: 0 }),
    () => ts,
    `http://127.0.0.1:${port}`,
  );
  const inbox = new ReefInboxConnection(
    client,
    async (received) => {
      entries.push(...received);
      abort.abort();
    },
    createReefWebSocket,
    {
      onState: (state) => {
        states.push(state);
        if (state === "disconnected") {
          abort.abort();
        }
      },
    },
  );

  try {
    await inbox.start(abort.signal);
  } finally {
    clearTimeout(timeout);
  }
  expect(Buffer.byteLength(frame)).toBe(bytes);
  expect({ entries, states }).toEqual({ entries: [], states: ["connected", "disconnected"] });
});

it("errors when the relay accepts TCP but never completes the upgrade", async () => {
  const server = http.createServer();
  server.on("upgrade", () => {
    // Leave the HTTP upgrade pending until the client deadline aborts it.
  });
  const port = await listen(server);

  const socket = createReefWebSocket(`ws://127.0.0.1:${port}`, {
    handshakeTimeoutMs: 50,
  }) as WebSocket;
  const [error] = await once(socket, "error");

  expect(error).toMatchObject({ message: "Opening handshake has timed out" });
});
