import { once } from "node:events";
import {
  GatewayControlUiIngressError,
  type GatewayControlUiIngressV2,
} from "openclaw/plugin-sdk/gateway-ingress";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codeHash } from "./protocol.js";
import {
  CHALLENGE,
  CLIENT,
  createPrincipalIngress,
  createTransportFixture,
  GATEWAY_ID,
  grantFixture,
  HTTP,
  IngressSocket,
  ORIGINS,
  PUBLIC_KEY,
  SIGNATURE,
  WS,
} from "./relay.test-helpers.js";
import type { RelayGrantAuthority } from "./state.js";

const unavailableUi = {
  available: false,
  reason: "Update the MCP relay to support the Control UI tunnel, then reconnect.",
};
const uiCapability = { frameAncestors: ["https://chatgpt.com"] };
const PERSON_AUTHORITY: RelayGrantAuthority = {
  principal: { kind: "person", profileId: "private-person-profile" },
  principalLabel: "Synthetic person",
  ceiling: ["operator.read", "operator.write"],
};
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
  it.each(["hello", "ui-unavailable", "ping"] as const)(
    "closes a saturated relay when sending %s control frames",
    async (kind) => {
      const f = await fixture();
      if (kind !== "hello") {
        await f.ready();
      }
      f.socket.bufferedAmount = 32 * 1024 * 1024;
      if (kind === "ping") {
        await f.clock.advanceBy(30_000);
      } else {
        expect(() => f.socket.receive(kind === "hello" ? CHALLENGE : HTTP)).not.toThrow();
      }
      expect(f.socket.terminated).toBe(true);
      await expect(f.service.status()).resolves.toMatchObject({ connected: false });
    },
  );

  it.each(["closed", "unsupported-auth"] as const)(
    "reopens a retired MCP binding after %s UI admission fails",
    async (code) => {
      const ingress = createPrincipalIngress({
        presentation: { ...ORIGINS, basePath: "/control", operatorScopeCeiling: ["operator.read"] },
        request: async () => ({ response: new Response("UI"), pluginReadCookies: [] }),
        openWebSocket: async () => ({ socket: new IngressSocket() }),
        close: async () => {},
      });
      const f = await fixture(undefined, { controlUiIngress: ingress.factory });
      await createGrant(f);
      await f.ready(f.socket, uiCapability);
      expect(
        await f.request({ id: "status", op: "status", grantId: "gr_one", params: {} }),
      ).toMatchObject({ ok: true });
      const binding = ingress.bindings[0]!.binding;
      if (code === "closed") {
        await binding.close();
      } else {
        vi.spyOn(binding, "openControlUi").mockRejectedValue(
          new GatewayControlUiIngressError(code, "Gateway authentication is unsupported."),
        );
      }
      f.socket.receive(HTTP);
      expect(await f.socket.nextFrame()).toMatchObject({ type: "ui.error", code: "unavailable" });
      f.socket.receive({ ...HTTP, sid: "fresh-ui" });
      expect(await f.socket.nextFrame()).toMatchObject({ type: "ui.http.head", status: 200 });
      expect(await f.socket.nextFrame()).toMatchObject({ type: "ui.http.body", b64: "VUk=" });
      expect(await f.socket.nextFrame()).toMatchObject({ type: "ui.http.body", more: false });
      expect(ingress.factory.bindPrincipal).toHaveBeenCalledTimes(2);
    },
  );

  it.each([false, true])("fails an overloaded UI send (saturated=%s)", async (saturated) => {
    const socket = new IngressSocket();
    const ingress = createPrincipalIngress({
      presentation: { ...ORIGINS, basePath: "/control", operatorScopeCeiling: ["operator.read"] },
      request: async () => ({ response: new Response("UI"), pluginReadCookies: [] }),
      openWebSocket: async () => ({ socket }),
      close: async () => socket.close(),
    });
    const f = await fixture(undefined, { controlUiIngress: ingress.factory });
    await createGrant(f);
    await f.ready(f.socket, uiCapability);
    f.socket.receive(WS);
    expect(await f.socket.nextFrame()).toMatchObject({ type: "ui.ws.opened" });
    f.socket.bufferedAmount = 32 * 1024 * 1024 - (saturated ? 0 : 1024);
    const relayClosed = saturated ? once(f.socket, "close") : undefined;
    socket.incoming.push({ kind: "text", text: "x".repeat(1024) });
    await f.clock.advanceBy(0);
    if (saturated) {
      await relayClosed;
      expect(f.socket.terminated).toBe(true);
    } else {
      expect(await f.socket.nextFrame()).toMatchObject({
        type: "ui.error",
        sid: WS.sid,
        code: "limit_exceeded",
      });
      expect(f.socket.terminated).toBe(false);
    }
    expect(socket.closes[0]?.code).toBe(1011);
    expect(f.socket.frames.some((frame) => frame.type === "ui.ws.msg")).toBe(false);
  });

  it("caps operation results at the relay publication boundary", async () => {
    const f = await fixture(async () => ({ text: "x".repeat(512 * 1024) }));
    await createGrant(f);
    await f.ready();
    expect(await f.request({ id: "large", op: "status", grantId: "gr_one", params: {} })).toEqual(
      denied("large", "too_large"),
    );
  });

  it("requires the current principal-bound ingress capability at startup", async () => {
    await expect(fixture(undefined, { controlUiIngress: undefined })).rejects.toThrow(
      "Update OpenClaw to enable principal-bound MCP and Control UI access.",
    );
  });

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
      ui: unavailableUi,
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

  it.each(["owner", "person"] as const)(
    "persists only the code hash and keeps %s profile IDs out of pairing offers",
    async (principal) => {
      const f = await fixture();
      await expect(f.service.pair()).rejects.toMatchObject({ code: "unavailable" });
      await f.ready();
      await f.clock.advanceBy(0);
      const pairing = f.service.pair(
        undefined,
        principal === "person" ? PERSON_AUTHORITY : undefined,
      );
      const offer = await f.socket.nextFrame();
      expect(offer).toEqual({
        type: "req",
        id: expect.any(String),
        op: "pair.offer",
        params: {
          codeHash: expect.any(String),
          expiresAt: 601_000,
          principal,
          ceiling: ["operator.read", "operator.write"],
          ...(principal === "person" ? { principalLabel: "Synthetic person" } : {}),
        },
      });
      const persisted = f.storage.persisted();
      expect(persisted).toContain('"code:');
      f.socket.acknowledge(offer);
      const paired = await pairing;
      expect(paired).toEqual({
        code: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/),
        expiresAt: 601_000,
        mcpUrl: "https://mcp.openclaw.ai/mcp",
      });
      expect(offer.params).toEqual({
        codeHash: codeHash(paired.code),
        expiresAt: paired.expiresAt,
        principal,
        ceiling: ["operator.read", "operator.write"],
        ...(principal === "person" ? { principalLabel: "Synthetic person" } : {}),
      });
      expect(persisted).toContain(codeHash(paired.code));
      expect(persisted).not.toContain(paired.code);
      expect(JSON.stringify(f.socket.frames)).not.toContain("private-person-profile");
      expect(
        await f.request({
          id: "pair",
          op: "grant.create",
          params: { grantId: "gr_paired", codeHash: codeHash(paired.code), client: CLIENT },
        }),
      ).toMatchObject({ ok: true });
      expect(f.state.getGrant("gr_paired")).toMatchObject({
        principal: principal === "person" ? PERSON_AUTHORITY.principal : { kind: "owner" },
        ceiling: ["operator.read", "operator.write"],
      });
      expect(
        await f.request({
          id: "reused",
          op: "grant.create",
          params: { grantId: "gr_again", codeHash: codeHash(paired.code), client: CLIENT },
        }),
      ).toEqual(denied("reused", "not_found"));
    },
  );

  it("acknowledges grant creation only after durable consumption", async () => {
    const f = await fixture();
    await f.ready();
    await f.state.issue(codeHash("issued"), f.scheduler.now() + 1_000, f.scheduler.now());
    const persist = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    f.storage.effects.beforeWrite = async () => {
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
    const restarted = f.storage.open();
    await restarted.initialize();
    await expect(restarted.grants()).resolves.toEqual([
      grantFixture({ grantId: "accepted", createdAt: 1_000 }),
    ]);
  });

  it.each(["unknown", "expired"])("refuses an %s pairing code", async (code) => {
    const f = await fixture();
    await f.ready();
    if (code === "expired") {
      await f.state.issue(codeHash(code), f.scheduler.now() + 1, f.scheduler.now());
      await f.clock.advanceBy(1);
    }
    expect(
      await f.request({
        id: "invalid-code",
        op: "grant.create",
        params: { grantId: "gr_no", codeHash: codeHash(code), client: CLIENT },
      }),
    ).toEqual(denied("invalid-code", "not_found"));
    expect(await f.state.grants()).toEqual([]);
  });

  it("refuses an offline-revoked grant after reconnect and restart", async () => {
    const f = await fixture();
    await createGrant(f);
    expect(await f.service.revoke("gr_one")).toEqual({ revoked: true, relayNotified: false });
    const restarted = f.storage.open();
    await restarted.initialize();
    expect(await restarted.grants()).toEqual([]);
    expect(() => restarted.assertGrantCurrent("gr_one")).toThrow("revoked");
    await f.ready();
    expect(await f.request({ id: "offline", op: "status", grantId: "gr_one", params: {} })).toEqual(
      denied("offline", "grant_revoked"),
    );
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
    expect(operations).toHaveBeenCalledWith(
      "status",
      {},
      expect.any(Function),
      expect.any(Function),
    );
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

  it("recovers from a socket factory failure and stops its retry after shutdown", async () => {
    const f = await fixture();
    f.socket.close(4409);
    f.effects.connectError = new Error("Synthetic connection failure");
    await f.clock.advanceBy(1_000);
    expect(f.sockets).toHaveLength(1);
    f.effects.connectError = undefined;
    await f.clock.advanceBy(2_000);
    expect(f.sockets).toHaveLength(2);
    await f.service.stop();
    expect(f.clock.armedAtMs).toBeNull();
  });

  it.each([null, {}, { frameAncestors: "https://chatgpt.com" }, { frameAncestors: [1] }])(
    "rejects malformed ready UI metadata: %j",
    async (ui) => {
      const f = await fixture();
      await f.ready(f.socket, ui);
      expect(f.socket.closes).toEqual([{ code: 4400, reason: "Invalid UI capability" }]);
    },
  );

  it("keeps person UI and MCP access available after an old owner grant fails admission", async () => {
    const reason = "Re-pair as a person from the Connected apps tab.";
    const handle = {
      presentation: { ...ORIGINS, basePath: "/control", operatorScopeCeiling: ["operator.read"] },
      request: async () => ({ response: new Response("person UI"), pluginReadCookies: [] }),
      openWebSocket: async () => ({ socket: new IngressSocket() }),
      close: vi.fn(async () => {}),
    } satisfies Omit<GatewayControlUiIngressV2, "requestGateway">;
    const ingress = createPrincipalIngress(handle);
    const bind = ingress.factory.bindPrincipal.getMockImplementation()!;
    ingress.factory.bindPrincipal.mockImplementation(async (options) => {
      if (options.principal.kind === "owner") {
        throw new GatewayControlUiIngressError("unsupported-auth", reason);
      }
      return bind(options);
    });
    const f = await fixture(undefined, {
      controlUiIngress: ingress.factory,
      config: () => ({ gateway: { controlUi: { basePath: " /control/ " } } }),
    });
    await createGrant(f);
    await f.state.approveGrant(
      grantFixture({
        grantId: "gr_person",
        createdAt: f.scheduler.now(),
        principal: { kind: "person", profileId: "profile-private" },
        ceiling: ["operator.read"],
      }),
      () => {},
    );
    await f.ready();
    expect((await f.service.status()).ui).toEqual(unavailableUi);
    f.socket.close(4409);
    await f.clock.advanceBy(0);
    await f.clock.advanceBy(1_000);
    const socket = f.sockets[1]!;
    await f.ready(socket, uiCapability);
    expect((await f.service.status()).ui).toEqual({ available: true, basePath: "/control" });
    expect(ingress.factory.bindPrincipal).not.toHaveBeenCalled();
    socket.receive(HTTP);
    await f.clock.advanceBy(0);
    expect(await socket.nextFrame()).toEqual({
      type: "ui.error",
      sid: HTTP.sid,
      code: "unavailable",
      message: reason,
    });
    expect((await f.service.status()).ui).toEqual({ available: true, basePath: "/control" });
    socket.receive({ ...HTTP, sid: "person01", grantId: "gr_person" });
    await f.clock.advanceBy(0);
    expect(await socket.nextFrame()).toMatchObject({ type: "ui.http.head", status: 200 });
    expect(await socket.nextFrame()).toMatchObject({
      type: "ui.http.body",
      b64: Buffer.from("person UI").toString("base64"),
    });
    expect(await socket.nextFrame()).toMatchObject({ type: "ui.http.body", more: false });
    socket.receive({
      type: "req",
      id: "person-status",
      op: "status",
      grantId: "gr_person",
      params: {},
    });
    await f.clock.advanceBy(0);
    expect(await socket.nextFrame()).toMatchObject({ id: "person-status", ok: true });
    expect(ingress.factory.bindPrincipal).toHaveBeenCalledTimes(2);
    expect(ingress.bindings[0]?.options).toMatchObject({
      audienceId: "gr_person",
      principal: { kind: "person", profileId: "profile-private" },
      operatorScopeCeiling: ["operator.read"],
    });
    expect(JSON.stringify(socket.frames)).not.toContain("profile-private");
    expect(ingress.factory.open).not.toHaveBeenCalled();
  });
});
