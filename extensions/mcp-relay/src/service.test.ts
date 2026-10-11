import { afterEach, describe, expect, it, vi } from "vitest";
import { codeHash } from "./protocol.js";
import {
  CHALLENGE,
  CLIENT,
  createTransportFixture,
  GATEWAY_ID,
  PUBLIC_KEY,
  SIGNATURE,
} from "./transport.test-helpers.js";

const fixtures: Awaited<ReturnType<typeof createTransportFixture>>[] = [];
async function fixture(...args: Parameters<typeof createTransportFixture>) {
  const value = await createTransportFixture(...args);
  fixtures.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((value) => value.stop()));
});

function denied(id: string, code: string) {
  return { type: "res", id, ok: false, error: { code, message: expect.any(String) } };
}

async function createGrant(f: Awaited<ReturnType<typeof fixture>>, grantId = "gr_one") {
  const hash = codeHash(grantId);
  await f.state.issue(hash, f.scheduler.now() + 600_000, f.scheduler.now());
  await f.state.createGrant({ grantId, codeHash: hash, client: CLIENT }, f.scheduler.now());
}

describe("MCP relay transport and authority", () => {
  it("signs the relay challenge, becomes ready, and sends text pings every 30 seconds", async () => {
    const f = await fixture();
    expect(f.addresses).toEqual([`wss://mcp.openclaw.ai/v1/gateway/connect?key=${PUBLIC_KEY}`]);
    await expect(f.service.status()).resolves.toMatchObject({ connected: false });
    expect(await f.ready()).toEqual({
      type: "hello",
      protocol: 1,
      signature: SIGNATURE,
      gateway: { name: "Synthetic Gateway", version: "2026.10.9" },
    });
    await expect(f.service.status()).resolves.toEqual({
      connected: true,
      gatewayId: GATEWAY_ID,
      relayUrl: "https://mcp.openclaw.ai",
      grantsCount: 0,
    });
    await f.clock.advanceBy(0);
    await f.clock.advanceBy(29_999);
    expect(f.socket.frames).toHaveLength(1);
    await f.clock.advanceBy(1);
    expect(await f.socket.nextFrame()).toEqual({ type: "ping" });
    f.socket.receive({ type: "pong" });
    await f.clock.advanceBy(30_000);
    expect(await f.socket.nextFrame()).toEqual({ type: "ping" });
    expect(f.socket.closes).toEqual([]);
  });

  it.each([
    { name: "wrong protocol", frame: { ...CHALLENGE, protocol: 2 }, helloFirst: false },
    { name: "wrong relay", frame: { ...CHALLENGE, relay: "other.example" }, helloFirst: false },
    { name: "short nonce", frame: { ...CHALLENGE, nonce: "AQ" }, helloFirst: false },
    {
      name: "noncanonical nonce",
      frame: { ...CHALLENGE, nonce: `${CHALLENGE.nonce.slice(0, -1)}d` },
      helloFirst: false,
    },
    { name: "premature ready", frame: { type: "ready", gatewayId: GATEWAY_ID }, helloFirst: false },
    { name: "wrong identity", frame: { type: "ready", gatewayId: "gw_other" }, helloFirst: true },
  ])("rejects a $name handshake", async ({ frame, helloFirst }) => {
    const f = await fixture();
    if (helloFirst) {
      f.socket.receive(CHALLENGE);
      await f.socket.nextFrame();
    }
    f.socket.receive(frame);
    expect(f.socket.closes).toEqual([{ code: 4400, reason: "Invalid handshake" }]);
    await expect(f.service.status()).resolves.toMatchObject({ connected: false });
  });

  it("times out an incomplete handshake and backs off a replacement connection", async () => {
    const f = await fixture();
    await f.clock.advanceBy(9_999);
    expect(f.socket.closes).toEqual([]);
    await f.clock.advanceBy(1);
    expect(f.socket.closes).toEqual([{ code: 4400, reason: "Handshake timed out" }]);
    expect(f.socket.terminated).toBe(true);
    await f.clock.advanceBy(0);
    expect(f.clock.armedAtMs).toBe(12_000);
    await f.clock.advanceBy(1_000);
    expect(f.sockets).toHaveLength(2);
  });

  it.each([
    { code: 4401, delays: [60_000, 60_000] },
    { code: 4409, delays: [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000] },
  ])("retries close $code with bounded backoff", async ({ code, delays }) => {
    const f = await fixture();
    for (const delay of delays) {
      const socket = f.sockets.at(-1);
      if (!socket) {
        throw new Error("Expected an active socket");
      }
      socket.close(code);
      await f.clock.advanceBy(0);
      const previousCount = f.sockets.length;
      expect(f.clock.armedAtMs).toBe(f.scheduler.now() + delay);
      await f.clock.advanceBy(delay - 1);
      expect(f.sockets).toHaveLength(previousCount);
      await f.clock.advanceBy(1);
      expect(f.sockets).toHaveLength(previousCount + 1);
    }
    await f.ready(f.sockets.at(-1));
    await f.clock.advanceBy(0);
    f.sockets.at(-1)?.close(4409);
    await f.clock.advanceBy(0);
    expect(f.clock.armedAtMs).toBe(f.scheduler.now() + 1_000);
  });

  it.each(["connected", "reconnecting"])("stops all scheduled work while %s", async (phase) => {
    const f = await fixture();
    await f.ready();
    await f.clock.advanceBy(0);
    if (phase === "reconnecting") {
      f.socket.close(4409);
      await f.clock.advanceBy(0);
    }
    await f.service.stop();
    if (phase === "connected") {
      expect(f.socket.terminated).toBe(true);
    }
    expect(f.clock.armedAtMs).toBeNull();
    await f.clock.advanceBy(120_000);
    expect(f.sockets).toHaveLength(1);
    expect(f.socket.frames).toHaveLength(1);
    await expect(f.service.pair()).rejects.toMatchObject({ code: "unavailable" });
  });

  it("persists only the code hash before offering a ten-minute pairing code", async () => {
    const f = await fixture();
    await expect(f.service.pair()).rejects.toMatchObject({ code: "unavailable" });
    await f.ready();
    await f.clock.advanceBy(0);
    const pairing = f.service.pair();
    const offer = await f.socket.nextFrame();
    expect(offer).toEqual({
      type: "req",
      id: expect.any(String),
      op: "pair.offer",
      params: { codeHash: expect.any(String), expiresAt: 601_000 },
    });
    const persisted = f.storage.persisted();
    expect(persisted).toContain('"consumed":false');
    f.socket.acknowledge(offer);
    const paired = await pairing;
    expect(paired).toEqual({
      code: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/),
      expiresAt: 601_000,
      mcpUrl: "https://mcp.openclaw.ai/mcp",
    });
    expect(offer.params).toEqual({ codeHash: codeHash(paired.code), expiresAt: paired.expiresAt });
    expect(persisted).toContain(codeHash(paired.code));
    expect(persisted).not.toContain(paired.code);
  });

  it("acknowledges grant creation only after durable consumption and maps all rejected codes to not_found", async () => {
    const f = await fixture();
    await f.ready();
    const request = (id: string, hash: string) =>
      f.request({
        id,
        op: "grant.create",
        params: { grantId: id, codeHash: hash, client: CLIENT },
      });
    expect(await request("unknown", codeHash("unknown"))).toEqual(denied("unknown", "not_found"));
    await f.state.issue(codeHash("expired"), f.scheduler.now(), f.scheduler.now() - 1);
    expect(await request("expired", codeHash("expired"))).toEqual(denied("expired", "not_found"));
    await f.state.issue(codeHash("issued"), f.scheduler.now() + 1_000, f.scheduler.now());
    const persist = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    f.storage.effects.beforeCompare = async () => {
      entered.resolve();
      await persist.promise;
    };
    const framesBeforeCommit = f.socket.frames.length;
    f.socket.receive({
      type: "req",
      id: "accepted",
      op: "grant.create",
      params: { grantId: "accepted", codeHash: codeHash("issued"), client: CLIENT },
    });
    const dispatch = f.clock.advanceBy(0);
    await entered.promise;
    expect(f.socket.frames).toHaveLength(framesBeforeCommit);
    persist.resolve();
    await dispatch;
    expect(await f.socket.nextFrame()).toEqual({
      type: "res",
      id: "accepted",
      ok: true,
      result: {},
    });
    await expect(f.storage.open().grants()).resolves.toEqual([
      { grantId: "accepted", clientId: CLIENT.id, clientName: CLIENT.name, createdAt: 1_000 },
    ]);
    expect(await request("consumed", codeHash("issued"))).toEqual(denied("consumed", "not_found"));
  });

  it("refuses unknown and revoked grants before calling data operations and records valid use", async () => {
    const operations = vi.fn(async () => ({ gateway: { name: "Synthetic Gateway" } }));
    const f = await fixture(operations);
    await createGrant(f);
    await f.ready();
    const request = (id: string, grantId: string) =>
      f.request({ id, op: "status", params: {}, grantId });
    expect(await request("unknown", "gr_missing")).toEqual(denied("unknown", "grant_revoked"));
    expect(operations).not.toHaveBeenCalled();
    await f.clock.advanceBy(25);
    expect(await request("valid", "gr_one")).toMatchObject({ ok: true });
    expect(operations).toHaveBeenCalledWith("status", {}, expect.any(Function));
    expect((await f.state.grants())[0]?.lastUsedAt).toBe(1_025);
    expect(
      await f.request({
        id: "revoked",
        op: "grant.revoked",
        params: { grantId: "gr_one", reason: "refresh_reuse" },
      }),
    ).toEqual({ type: "res", id: "revoked", ok: true, result: {} });
    expect(await request("denied", "gr_one")).toEqual(denied("denied", "grant_revoked"));
    expect(operations).toHaveBeenCalledOnce();
    expect(
      await f.request({
        id: "early-revocation",
        op: "grant.revoked",
        params: { grantId: "gr_early", reason: "client_revoked" },
      }),
    ).toEqual({ type: "res", id: "early-revocation", ok: true, result: {} });
    const hash = codeHash("late-creation");
    await f.state.issue(hash, f.scheduler.now() + 1_000, f.scheduler.now());
    expect(
      await f.request({
        id: "late-creation",
        op: "grant.create",
        params: { grantId: "gr_early", codeHash: hash, client: CLIENT },
      }),
    ).toEqual(denied("late-creation", "not_found"));
    expect(await request("still-revoked", "gr_early")).toEqual(
      denied("still-revoked", "grant_revoked"),
    );
  });

  it("persists a local revocation before sending grant.revoke", async () => {
    const f = await fixture();
    await createGrant(f);
    await f.ready();
    await f.clock.advanceBy(0);
    const persist = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    f.storage.effects.beforeCompare = async () => {
      entered.resolve();
      await persist.promise;
    };
    const revoking = f.service.revoke("gr_one");
    await entered.promise;
    expect(f.socket.frames).toHaveLength(1);
    persist.resolve();
    const request = await f.socket.nextFrame();
    expect(request).toEqual({
      type: "req",
      id: expect.any(String),
      op: "grant.revoke",
      params: { grantId: "gr_one" },
    });
    expect((await f.storage.open().grants())[0]?.revokedAt).toBe(1_000);
    f.socket.acknowledge(request);
    await expect(revoking).resolves.toEqual({ revoked: true, relayNotified: true });
  });

  it("replays an offline revocation after authentication on the next connection", async () => {
    const f = await fixture();
    await createGrant(f);
    await expect(f.service.revoke("gr_one")).resolves.toEqual({
      revoked: true,
      relayNotified: false,
    });
    await f.ready();
    // Replay waits for an acknowledgement; keep its scheduled callback in flight.
    const replay = f.clock.advanceBy(0);
    const request = await f.socket.nextFrame();
    expect(request).toMatchObject({ op: "grant.revoke", params: { grantId: "gr_one" } });
    expect((await f.storage.open().grants())[0]?.revokedAt).toBe(1_000);
    f.socket.acknowledge(request);
    await replay;
  });

  it("withholds an awaited data result if its grant was revoked meanwhile", async () => {
    const result = Promise.withResolvers<unknown>();
    const entered = Promise.withResolvers<void>();
    const f = await fixture(async () => {
      entered.resolve();
      return result.promise;
    });
    await createGrant(f);
    await f.ready();
    await f.clock.advanceBy(0);
    f.socket.receive({
      type: "req",
      id: "read",
      op: "conversation.read",
      grantId: "gr_one",
      params: {},
    });
    const dispatch = f.clock.advanceBy(0);
    await entered.promise;
    await f.state.revoke("gr_one", f.scheduler.now());
    result.resolve({ messages: [{ text: "Private result" }] });
    await dispatch;
    expect(await f.socket.nextFrame()).toEqual(denied("read", "grant_revoked"));
  });

  it("terminates and reconnects when no pong arrives within two keepalive intervals", async () => {
    const f = await fixture();
    await f.ready();
    await f.clock.advanceBy(0);
    await f.clock.advanceBy(30_000);
    expect(await f.socket.nextFrame()).toEqual({ type: "ping" });
    await f.clock.advanceBy(29_999);
    expect(f.socket.closes).toEqual([]);
    await f.clock.advanceBy(1);
    expect(f.socket.closes).toEqual([{ code: 1001, reason: "Relay keepalive timed out" }]);
    expect(f.socket.terminated).toBe(true);
    await expect(f.service.status()).resolves.toMatchObject({ connected: false });
    await f.clock.advanceBy(0);
    await f.clock.advanceBy(1_000);
    expect(f.sockets).toHaveLength(2);
  });

  it("joins retired connection scopes even when the socket factory fails", async () => {
    const f = await fixture();
    const openScope = f.scheduler.scope;
    const scopes = vi.spyOn(f.scheduler, "scope").mockImplementation(() => {
      const child = openScope();
      vi.spyOn(child, "stop");
      return child;
    });
    f.socket.close(4409);
    await f.clock.advanceBy(0);
    f.effects.connectError = new Error("Synthetic connection failure");
    await f.clock.advanceBy(1_000);
    await f.clock.advanceBy(0);
    expect(scopes).toHaveBeenCalledOnce();
    const failedScope = scopes.mock.results[0];
    if (failedScope?.type !== "return") {
      throw new Error("Expected a connection scope");
    }
    expect(failedScope.value.signal.aborted).toBe(true);
    expect(failedScope.value.stop).toHaveBeenCalledOnce();
    f.effects.connectError = undefined;
    await f.clock.advanceBy(2_000);
    expect(f.sockets).toHaveLength(2);
    const reconnectedScope = scopes.mock.results[1];
    if (reconnectedScope?.type !== "return") {
      throw new Error("Expected a replacement connection scope");
    }
    f.sockets[1]?.close(4409);
    await f.clock.advanceBy(0);
    expect(reconnectedScope.value.signal.aborted).toBe(true);
    expect(reconnectedScope.value.stop).toHaveBeenCalledOnce();
  });

  it("rejects pending relay requests before joining their closing connection scope", async () => {
    const f = await fixture();
    await createGrant(f);
    await f.service.revoke("gr_one");
    await f.ready();
    const replay = f.clock.advanceBy(0);
    const request = await f.socket.nextFrame();
    expect(request).toMatchObject({ op: "grant.revoke" });
    f.socket.close(4409);
    await replay;
    await f.clock.advanceBy(0);
    await f.clock.advanceBy(1_000);
    expect(f.sockets).toHaveLength(2);
  });

  it.each(["revoked", "disconnected"])(
    "rechecks %s authority after operation preparation without blocking unrelated requests",
    async (change) => {
      const prepared = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const mutate = vi.fn();
      const f = await fixture(async (op, _params, assertAuthority) => {
        if (op === "message.send") {
          prepared.resolve();
          await resume.promise;
          await assertAuthority();
          mutate();
        }
        return {};
      });
      await createGrant(f);
      await f.ready();
      await f.clock.advanceBy(0);
      f.socket.receive({
        type: "req",
        id: "send",
        op: "message.send",
        grantId: "gr_one",
        params: {},
      });
      const sending = f.clock.advanceBy(0);
      await prepared.promise;
      expect(
        await f.request({
          id: "status",
          op: "status",
          grantId: "gr_one",
          params: {},
        }),
      ).toEqual({ type: "res", id: "status", ok: true, result: {} });
      if (change === "revoked") {
        await f.state.revoke("gr_one", f.scheduler.now());
      } else {
        f.socket.close(4409);
      }
      resume.resolve();
      await sending;
      expect(mutate).not.toHaveBeenCalled();
      if (change === "revoked") {
        expect(await f.socket.nextFrame()).toEqual(denied("send", "grant_revoked"));
      } else {
        expect(f.socket.frames.some((frame) => frame.id === "send")).toBe(false);
      }
    },
  );

  it("rechecks the connection after an awaited grant authorization before dispatching", async () => {
    const operations = vi.fn(async () => ({}));
    const f = await fixture(operations);
    await createGrant(f);
    await f.ready();
    await f.clock.advanceBy(0);
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    f.storage.effects.beforeCompare = async () => {
      entered.resolve();
      await resume.promise;
    };
    f.socket.receive({
      type: "req",
      id: "send",
      op: "message.send",
      grantId: "gr_one",
      params: {},
    });
    const dispatch = f.clock.advanceBy(0);
    await entered.promise;
    f.socket.close(4409);
    resume.resolve();
    await dispatch;
    expect(operations).not.toHaveBeenCalled();
    expect(f.socket.frames.some((frame) => frame.id === "send")).toBe(false);
  });

  it("rejects an oversized incoming frame before dispatch", async () => {
    const f = await fixture();
    f.socket.emit("message", Buffer.alloc(1024 * 1024 + 1, 32), false);
    expect(f.socket.closes).toEqual([{ code: 1009, reason: "Frame too large" }]);
  });
});
