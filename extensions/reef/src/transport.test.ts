import { createPublicKey, verify as verifySignature } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalBytes, fromBase64url, sha256Hex } from "../protocol/index.js";
import { ReefTransportClient } from "./transport.js";
import type { ReefKeys, RelayFriend } from "./types.js";

const ts = 1_752_300_000;
const signing = {
  secretKey: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
  publicKey: "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg",
};
const keys: ReefKeys = {
  signing,
  encryption: {
    secretKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  },
  auditKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  replayKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  keyEpoch: 1,
};

function verifyRelaySignature(
  signature: string,
  input: { method: string; path: string; ts: number; bodySha256: string },
): boolean {
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  const publicKey = createPublicKey({
    key: Buffer.concat([spkiPrefix, Buffer.from(fromBase64url(signing.publicKey))]),
    format: "der",
    type: "spki",
  });
  return verifySignature(
    null,
    canonicalBytes(input),
    publicKey,
    Buffer.from(fromBase64url(signature)),
  );
}

describe("ReefTransportClient device authentication", () => {
  it("signs the relay canonical REST path including its query and emits auth headers", async () => {
    const calls: Array<[URL | RequestInfo, RequestInit | undefined]> = [];
    const fetcher: typeof fetch = async (input, init) => {
      calls.push([input, init]);
      return Response.json({ entries: [], cursor: 5 });
    };
    const client = new ReefTransportClient(
      "https://relay.example",
      "alice",
      keys,
      fetcher,
      () => ts,
    );

    await expect(client.pull(5)).resolves.toEqual({ entries: [], cursor: 5 });

    const [requestUrl, init] = calls[0]!;
    expect(requestUrl instanceof URL ? requestUrl.href : requestUrl).toBe(
      "https://relay.example/v1/mail?after=5",
    );
    expect(init?.method).toBe("GET");
    const headers = new Headers(init?.headers);
    expect(headers.get("x-reef-handle")).toBe("alice");
    expect(headers.get("x-reef-ts")).toBe(String(ts));
    expect(headers.get("x-reef-sig")).toBe(
      "1Zx-WD8JygVzq8pdTWULPiEZyoLuoJ1zyokkDRGlPWu_6fAKxEfJHPZkCQaZ8DIS4LERDqeh2z6-qlw7BtcoDw",
    );

    const canonical = {
      method: "GET",
      path: "/v1/mail?after=5",
      ts,
      bodySha256: sha256Hex(new Uint8Array()),
    };
    expect(new TextDecoder().decode(canonicalBytes(canonical))).toBe(
      '{"bodySha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","method":"GET","path":"/v1/mail?after=5","ts":1752300000}',
    );
    expect(verifyRelaySignature(headers.get("x-reef-sig")!, canonical)).toBe(true);
  });

  it("puts WebSocket auth in the query but signs the bare relay path", () => {
    const client = new ReefTransportClient(
      "https://relay.example",
      "alice",
      keys,
      vi.fn() as typeof fetch,
      () => ts,
    );
    const url = new URL(client.websocketUrl());

    expect(url.protocol).toBe("wss:");
    expect(url.pathname).toBe("/v1/mail/ws");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      handle: "alice",
      ts: String(ts),
      sig: "teC4QkpLUCMghGA-PkBGBMZFPxNeERmNfGCivaxpYhL8q81v6ReHRKEq2ZVvOd-FG3d3BbMjk-FcvoKjW5kwAA",
    });
    expect(
      verifyRelaySignature(url.searchParams.get("sig")!, {
        method: "GET",
        path: "/v1/mail/ws",
        ts,
        bodySha256: sha256Hex(new Uint8Array()),
      }),
    ).toBe(true);
  });

  it("binds friendship responses to the exact listed peer key snapshot", async () => {
    const calls: RequestInit[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      calls.push(init ?? {});
      return Response.json({ peer: "bob", status: "active" });
    };
    const client = new ReefTransportClient(
      "https://relay.example",
      "alice",
      keys,
      fetcher,
      () => ts,
    );
    const friend: RelayFriend = {
      peer: "bob",
      status: "pending",
      initiated_by: "bob",
      vouching_mutual: null,
      ed25519_pub: "B".repeat(43),
      x25519_pub: "C".repeat(43),
      key_epoch: 2,
    };

    await expect(client.respondFriend(friend, true)).resolves.toEqual({
      peer: "bob",
      status: "active",
    });
    expect(JSON.parse(new TextDecoder().decode(calls[0]?.body as Uint8Array))).toEqual({
      peer: "bob",
      accept: true,
      expected_key_epoch: 2,
      expected_ed25519_pub: "B".repeat(43),
      expected_x25519_pub: "C".repeat(43),
    });
  });

  it("bumps ts monotonically so identical same-second requests never share a replay key", async () => {
    const seenTs: string[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      seenTs.push(new Headers(init?.headers).get("x-reef-ts")!);
      return Response.json({ friendships: [] });
    };
    const client = new ReefTransportClient(
      "https://relay.example",
      "alice",
      keys,
      fetcher,
      () => ts,
    );

    await client.listFriends();
    await client.listFriends();
    await client.listFriends();

    expect(seenTs).toEqual([String(ts), String(ts + 1), String(ts + 2)]);
    expect(new Set(seenTs).size).toBe(3);
  });
});

function createTrackedOverflowResponse(params: {
  status: number;
  chunkBytes: number;
  totalChunks: number;
}): {
  response: Response;
  state: { emittedBytes: number; cancelled: boolean };
} {
  const chunk = new Uint8Array(params.chunkBytes).fill(0x78);
  const state = { emittedBytes: 0, cancelled: false };
  let remaining = params.totalChunks;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (remaining <= 0) {
        controller.close();
        return;
      }
      remaining -= 1;
      state.emittedBytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return {
    response: new Response(body, {
      status: params.status,
      headers: { "content-type": "application/json" },
    }),
    state,
  };
}

describe("ReefTransportClient response body bounds", () => {
  it("accepts near-limit success JSON without cancelling the stream", async () => {
    const payload = { entries: [], cursor: 9, pad: "x".repeat(8 * 1024) };
    const body = JSON.stringify(payload);
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const client = new ReefTransportClient(
      "https://relay.example",
      "alice",
      keys,
      async () => response,
      () => ts,
    );

    await expect(client.pull(0)).resolves.toEqual(payload);
    expect(cancelled).toBe(false);
  });

  it("cancels oversized success bodies before buffering the rest", async () => {
    const offered = createTrackedOverflowResponse({
      status: 200,
      chunkBytes: 64 * 1024,
      totalChunks: 320, // 20 MiB offered
    });
    const client = new ReefTransportClient(
      "https://relay.example",
      "alice",
      keys,
      async () => offered.response,
      () => ts,
    );

    await expect(client.pull(0)).rejects.toThrow(
      /reef\.relay: JSON response exceeds 16777216 bytes/,
    );
    expect(offered.state.cancelled).toBe(true);
    expect(offered.state.emittedBytes).toBeGreaterThan(16 * 1024 * 1024);
    expect(offered.state.emittedBytes).toBeLessThan(20 * 1024 * 1024);
  });

  it("keeps status fallback and cancels oversized error bodies", async () => {
    const offered = createTrackedOverflowResponse({
      status: 503,
      chunkBytes: 8 * 1024,
      totalChunks: 16, // 128 KiB offered against 64 KiB error cap
    });
    const client = new ReefTransportClient(
      "https://relay.example",
      "alice",
      keys,
      async () => offered.response,
      () => ts,
    );

    await expect(client.listFriends()).rejects.toMatchObject({
      name: "ReefRelayError",
      status: 503,
      message: "relay HTTP 503",
    });
    expect(offered.state.cancelled).toBe(true);
    expect(offered.state.emittedBytes).toBeGreaterThan(64 * 1024);
    expect(offered.state.emittedBytes).toBeLessThan(128 * 1024);
  });

  it("still surfaces bounded relay error messages", async () => {
    const client = new ReefTransportClient(
      "https://relay.example",
      "alice",
      keys,
      async () => Response.json({ error: "friend code expired" }, { status: 400 }),
      () => ts,
    );

    await expect(client.requestFriend("bob", "code")).rejects.toMatchObject({
      name: "ReefRelayError",
      status: 400,
      message: "friend code expired",
    });
  });
});
