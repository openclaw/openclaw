import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig, record, SimlockClient } from "./client.js";
import { SimlockController, type Owner } from "./controller.js";

const TOKEN = "synthetic-fixture-token-not-a-credential";
const DEVICE = "synthetic-private-device-id";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=",
  "base64",
);
const owner: Owner = {
  agentId: "test-agent",
  sessionKey: "test-session",
  sessionId: "incarnation-1",
};
const invocation = { assertCurrent: () => {} };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type Call = { method: string; path: string; body?: Record<string, unknown>; leaseHeader?: string };
async function fixture() {
  let now = Date.now();
  const calls: Call[] = [];
  const leases = new Map<string, Record<string, unknown>>();
  const behavior = {
    healthOk: true,
    waiting: [] as unknown[],
    rpcError: false,
    redirect: false,
    badEnvelope: false,
    badScope: false,
    statusHook: () => {},
    holdAllocate: undefined as undefined | ReturnType<typeof deferred>,
    entered: deferred(),
    cache: "unchanged-app-cache",
  };
  async function handle(req: IncomingMessage, res: ServerResponse) {
    expect(req.headers.authorization).toBe("Bearer " + TOKEN);
    const path = req.url ?? "";
    let body: Record<string, unknown> | undefined;
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.from(chunk));
      }
      body = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    }
    calls.push({
      method: req.method ?? "",
      path,
      body,
      leaseHeader:
        typeof req.headers["x-agent-device-lease-id"] === "string"
          ? req.headers["x-agent-device-lease-id"]
          : undefined,
    });
    const send = (value: unknown, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (behavior.redirect) {
      res.writeHead(302, { Location: "/credential-collector" });
      res.end();
      return;
    }
    if (path === "/v1/agent-device/health") {
      send({
        ok: behavior.healthOk,
        service: "agent-device-proxy",
        version: "0.21.35",
        rpcProtocolVersion: 2,
        error: TOKEN,
      });
      return;
    }
    if (path === "/v1/status") {
      behavior.statusHook();
      send({
        daemon: { health: "healthy" },
        waiting: behavior.waiting,
        devices: [
          {
            id: DEVICE,
            physical: false,
            state: "ready",
            spec: { physical: false, platform: "ios", model: "fixture-model", osVersion: "26.0" },
          },
        ],
        leases: [...leases].map(([id, scope]) => ({
          id: "worker." + id,
          requesterId: id,
          deviceId: DEVICE,
          ownerId: "private-tenant",
          ttlDeadline: scope.expiresAt,
        })),
      });
      return;
    }
    if (path.startsWith("/v1/leases/") && req.method === "DELETE") {
      const id = decodeURIComponent(path.slice("/v1/leases/".length)).replace(/^worker\./, "");
      if (!leases.delete(id)) {
        send({ error: TOKEN }, 404);
        return;
      }
      send({ released: true, device: { id: DEVICE, state: "reclaiming" } }, 202);
      return;
    }
    if (path.startsWith("/v1/agent-device/artifacts/")) {
      expect(req.headers["x-agent-device-lease-id"]).toBe([...leases.keys()][0]);
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(PNG);
      return;
    }
    if (path === "/v1/agent-device/rpc" && body) {
      const params = record(body.params);
      const method = String(body.method);
      const reply = (data: unknown) =>
        send({
          jsonrpc: "2.0",
          id: behavior.badEnvelope ? "wrong-id" : body.id,
          result: { ok: true, data },
        });
      if (behavior.rpcError) {
        send({
          jsonrpc: "2.0",
          id: body.id,
          error: {
            code: -32000,
            message: TOKEN + DEVICE,
            data: { code: "UNAUTHORIZED", details: { reason: "LEASE_REVOKED" } },
          },
        });
        return;
      }
      if (method === "agent_device.lease.allocate") {
        expect(params.leaseId).toMatch(/^[a-f0-9]{32}$/);
        expect(params.leaseProvider).toBe("proxy");
        expect(params).not.toHaveProperty("physical", true);
        const scope = {
          leaseId: params.leaseId,
          tenantId: "private-tenant",
          runId: params.runId,
          clientId: params.clientId,
          deviceKey: "ios:mobile:" + DEVICE,
          leaseProvider: "proxy",
          backend: "ios-instance",
          createdAt: now,
          heartbeatAt: now,
          expiresAt: now + Number(params.ttlMs),
          device: { model: "fixture-model", osVersion: "26.0", physical: false },
        };
        leases.set(String(params.leaseId), scope);
        behavior.entered.resolve();
        if (behavior.holdAllocate) {
          await behavior.holdAllocate.promise;
        }
        reply({
          lease: { ...scope, ...(behavior.badScope ? { clientId: "foreign-client" } : {}) },
        });
        return;
      }
      if (method === "agent_device.lease.heartbeat") {
        const scope = leases.get(String(params.leaseId));
        if (!scope) {
          send({ error: TOKEN }, 404);
          return;
        }
        Object.assign(scope, { heartbeatAt: now, expiresAt: now + Number(params.ttlMs) });
        reply({ lease: scope });
        return;
      }
      if (method === "agent_device.command") {
        const meta = record(params.meta);
        const scope = leases.get(String(meta.leaseId));
        expect(scope).toBeDefined();
        expect(meta.leaseBackend).toBe("ios-instance");
        expect(meta).not.toHaveProperty("backend");
        expect(meta.deviceKey).toBe(scope?.deviceKey);
        if (params.command === "snapshot") {
          reply({
            nodes: [
              {
                index: 0,
                ref: "e1",
                type: "Button",
                label: "Sign in " + TOKEN + DEVICE,
                pid: 123,
                bundleId: "private.app",
                deviceId: DEVICE,
              },
            ],
            session: params.session,
            deviceId: DEVICE,
            debug: TOKEN + " " + DEVICE,
          });
          return;
        }
        if (params.command === "screenshot") {
          reply({
            path: "/private/server.png",
            artifacts: [
              { field: "path", artifactType: "screenshot", artifactId: "private-artifact" },
            ],
          });
          return;
        }
        if (params.command === "open") {
          expect(params.flags).toEqual({ platform: "ios" });
        }
        reply({ path: "/private/server-path", device: DEVICE });
        return;
      }
    }
    send({ message: TOKEN + DEVICE }, 403);
  }
  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("No test listener");
  }
  const client = new SimlockClient(
    parseConfig({ gatewayUrl: "http://127.0.0.1:" + address.port, token: TOKEN }),
  );
  const controller = new SimlockController(client, () => now);
  cleanups.push(async () => {
    behavior.holdAllocate?.resolve();
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });
  return {
    controller,
    client,
    calls,
    leases,
    behavior,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function allocationCalls(calls: Call[]) {
  return calls.filter((call) => call.body?.method === "agent_device.lease.allocate");
}
function commands(calls: Call[]) {
  return calls.filter((call) => call.body?.method === "agent_device.command");
}

describe("Simlock pinned HTTP/RPC boundary (synthetic, not a live device)", () => {
  it("discovers read-only availability without infrastructure identifiers", async () => {
    const f = await fixture();
    const result = await f.controller.discover(owner, invocation);
    expect(result).toEqual({
      compatible: true,
      protocol: 2,
      devices: [{ platform: "ios", available: true }],
    });
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
    expect(JSON.stringify(result)).not.toContain(DEVICE);
    f.behavior.healthOk = false;
    await expect(f.controller.acquire(owner, "ios", 60000, invocation)).rejects.toMatchObject({
      code: "INCOMPATIBLE",
    });
    expect(allocationCalls(f.calls)).toHaveLength(0);
  });

  it("binds one receipt to agent, session, and incarnation, not the shared token", async () => {
    const f = await fixture();
    const lease = await f.controller.acquire(owner, "ios", 60000, invocation);
    expect(lease.state).toBe("active");
    expect(JSON.stringify(lease)).not.toContain(DEVICE);
    await expect(f.controller.acquire(owner, "ios", 60000, invocation)).rejects.toMatchObject({
      code: "EXISTING_LEASE",
    });
    for (const other of [
      { ...owner, sessionId: "incarnation-2" },
      { ...owner, agentId: "other" },
      { ...owner, sessionKey: "other" },
    ]) {
      await expect(
        f.controller.release(other, lease.lease, "release-and-wipe", invocation),
      ).rejects.toMatchObject({ code: "OWNER" });
      await expect(
        f.controller.ui(other, lease.lease, "open", [], invocation),
      ).rejects.toMatchObject({ code: "OWNER" });
    }
    expect(allocationCalls(f.calls)).toHaveLength(1);
    expect(f.calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
  });

  it("rejects concurrent operations without double acquisition or cross-session locks", async () => {
    const f = await fixture();
    f.behavior.holdAllocate = deferred();
    const first = f.controller.acquire(owner, "ios", 60000, invocation);
    await f.behavior.entered.promise;
    await expect(f.controller.acquire(owner, "ios", 60000, invocation)).rejects.toMatchObject({
      code: "BUSY",
    });
    const second = f.controller.discover({ ...owner, sessionId: "other" }, invocation);
    await expect(second).resolves.toMatchObject({ compatible: true });
    f.behavior.holdAllocate.resolve();
    await first;
    expect(allocationCalls(f.calls)).toHaveLength(1);
  });

  it("keeps an interrupted acquisition receipt and explicitly releases only its settled lease", async () => {
    const f = await fixture();
    const abort = new AbortController();
    f.behavior.holdAllocate = deferred();
    const pending = f.controller.acquire(owner, "ios", 60000, {
      ...invocation,
      signal: abort.signal,
    });
    await f.behavior.entered.promise;
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    f.behavior.holdAllocate.resolve();
    await expect(f.controller.acquire(owner, "ios", 60000, invocation)).rejects.toMatchObject({
      code: "EXISTING_LEASE",
    });
    const status = await f.controller.status(owner, undefined, invocation);
    if (!("lease" in status)) {
      throw new Error("Receipt lost");
    }
    expect(status.state).toBe("uncertain");
    await expect(
      f.controller.release(owner, status.lease, "release-and-wipe", invocation),
    ).resolves.toMatchObject({ released: true });
    expect(allocationCalls(f.calls)).toHaveLength(1);
    expect(f.leases.size).toBe(0);
  });

  it("rechecks live invocation authority after reads and before any effect", async () => {
    const f = await fixture();
    const lease = await f.controller.acquire(owner, "ios", 60000, invocation);
    let current = true;
    f.behavior.statusHook = () => {
      current = false;
    };
    await expect(
      f.controller.ui(owner, lease.lease, "open", [], {
        assertCurrent: () => {
          if (!current) {
            throw new Error(TOKEN);
          }
        },
      }),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(commands(f.calls)).toHaveLength(0);
    expect(f.leases.size).toBe(1);
  });

  it("stops on renewal failure/expiry and never silently substitutes a device", async () => {
    const f = await fixture();
    const lease = await f.controller.acquire(owner, "ios", 10000, invocation);
    f.behavior.rpcError = true;
    await expect(f.controller.renew(owner, lease.lease, 10000, invocation)).rejects.toMatchObject({
      code: "RPC",
    });
    await expect(f.controller.ui(owner, lease.lease, "open", [], invocation)).rejects.toMatchObject(
      { code: "INACTIVE" },
    );
    f.behavior.rpcError = false;
    await expect(f.controller.renew(owner, lease.lease, 10000, invocation)).resolves.toMatchObject({
      state: "active",
    });
    f.advance(11000);
    await expect(f.controller.renew(owner, lease.lease, 10000, invocation)).rejects.toMatchObject({
      code: "ENDED",
    });
    await expect(f.controller.ui(owner, lease.lease, "open", [], invocation)).rejects.toMatchObject(
      { code: "INACTIVE" },
    );
    expect(allocationCalls(f.calls)).toHaveLength(1);
  });

  it("enforces finite TTL and absolute renewal budget without background timers", async () => {
    const f = await fixture();
    await expect(f.controller.acquire(owner, "ios", 0, invocation)).rejects.toMatchObject({
      code: "TTL",
    });
    const lease = await f.controller.acquire(owner, "ios", 300000, invocation);
    for (let i = 0; i < 5; i++) {
      f.advance(290000);
      await f.controller.renew(owner, lease.lease, 300000, invocation);
    }
    f.advance(100000);
    await expect(f.controller.renew(owner, lease.lease, 300000, invocation)).rejects.toMatchObject({
      code: "RENEWAL_LIMIT",
    });
    expect(allocationCalls(f.calls)).toHaveLength(1);
  });

  it("preserves scope across factories/reopens and sends no reset, reinstall, close, or arbitrary flags", async () => {
    const f = await fixture();
    const lease = await f.controller.acquire(owner, "ios", 60000, invocation);
    await f.controller.ui(owner, lease.lease, "open", ["com.example.fixture"], invocation);
    await f.controller.ui({ ...owner }, lease.lease, "open", ["com.example.fixture"], invocation);
    await f.controller.ui(owner, lease.lease, "fill", ["@e2", "hello"], invocation);
    const scopes = commands(f.calls).map((call) => record(call.body?.params).meta);
    expect(scopes[0]).toEqual(scopes[1]);
    expect(commands(f.calls).map((call) => record(call.body?.params).command)).toEqual([
      "open",
      "open",
      "fill",
    ]);
    expect(allocationCalls(f.calls)).toHaveLength(1);
    for (const args of [["--reset"], ["https://example.invalid"], ["/private/path"]]) {
      await expect(
        f.controller.ui(owner, lease.lease, "open", args, invocation),
      ).rejects.toMatchObject({ code: "UI_ARGUMENTS" });
    }
  });

  it("returns redacted accessibility content and lease-routed PNG bytes, not private paths", async () => {
    const f = await fixture();
    const lease = await f.controller.acquire(owner, "ios", 60000, invocation);
    const snapshot = await f.controller.ui(owner, lease.lease, "snapshot", [], invocation);
    const text = JSON.stringify(snapshot);
    expect(text).toContain("Sign in");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(DEVICE);
    const image = await f.controller.ui(owner, lease.lease, "screenshot", [], invocation);
    expect("image" in image && image.image).toEqual(PNG);
    expect(image).not.toHaveProperty("path");
    expect(f.calls.at(-1)?.path).toBe("/v1/agent-device/artifacts/private-artifact");
  });

  it("requires explicit wipe authorization and releases no unrelated lease", async () => {
    const f = await fixture();
    const lease = await f.controller.acquire(owner, "ios", 60000, invocation);
    f.leases.set("unrelated", { expiresAt: Date.now() + 60000 });
    await expect(
      f.controller.release(owner, lease.lease, "release", invocation),
    ).rejects.toMatchObject({ code: "CONFIRM_RELEASE" });
    expect(f.calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
    await expect(
      f.controller.release(owner, lease.lease, "release-and-wipe", invocation),
    ).resolves.toMatchObject({ released: true });
    expect([...f.leases.keys()]).toEqual(["unrelated"]);
    expect(await f.controller.status(owner, undefined, invocation)).toEqual({ state: "none" });
  });

  it("redacts malformed RPC/errors and never follows credential-bearing redirects", async () => {
    const f = await fixture();
    f.behavior.badScope = true;
    await expect(f.controller.acquire(owner, "ios", 60000, invocation)).rejects.toMatchObject({
      code: "SCOPE",
    });
    const status = await f.controller.status(owner, undefined, invocation);
    if (!("lease" in status)) {
      throw new Error("No retained receipt");
    }
    await f.controller.release(owner, status.lease, "release-and-wipe", invocation);
    f.behavior.badScope = false;
    f.behavior.badEnvelope = true;
    await expect(f.controller.acquire(owner, "ios", 60000, invocation)).rejects.toMatchObject({
      code: "PROTOCOL",
    });
    f.behavior.redirect = true;
    await expect(f.client.health(invocation)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(f.calls.some((call) => call.path === "/credential-collector")).toBe(false);
  });
});

it("retires a reconciled unallocated receipt only after bounded upstream windows", async () => {
  const f = await fixture();
  f.behavior.rpcError = true;
  await expect(f.controller.acquire(owner, "ios", 60000, invocation)).rejects.toMatchObject({
    code: "RPC",
  });
  const status = await f.controller.status(owner, undefined, invocation);
  if (!("lease" in status)) {
    throw new Error("Missing retained receipt");
  }
  await expect(
    f.controller.release(owner, status.lease, "release-and-wipe", invocation),
  ).rejects.toMatchObject({ code: "UNCERTAIN" });
  f.advance(630001);
  await expect(
    f.controller.release(owner, status.lease, "release-and-wipe", invocation),
  ).resolves.toMatchObject({ released: false, state: "reconciled-unallocated" });
  f.behavior.rpcError = false;
  await expect(f.controller.acquire(owner, "ios", 60000, invocation)).resolves.toMatchObject({
    state: "active",
  });
  expect(f.calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
});

it("does not retire an uncertain receipt while its own request remains pending", async () => {
  const f = await fixture();
  f.behavior.rpcError = true;
  await expect(f.controller.acquire(owner, "ios", 60000, invocation)).rejects.toMatchObject({
    code: "RPC",
  });
  const request = record(allocationCalls(f.calls)[0]?.body?.params);
  f.behavior.waiting.push({
    id: "pending-fixture",
    requesterId: request.leaseId,
    spec: { platform: "ios" },
    createdAt: Date.now(),
    stage: "queued",
  });
  f.advance(630001);
  const status = await f.controller.status(owner, undefined, invocation);
  if (!("lease" in status)) {
    throw new Error("Missing retained receipt");
  }
  await expect(
    f.controller.release(owner, status.lease, "release-and-wipe", invocation),
  ).rejects.toMatchObject({ code: "UNCERTAIN" });
});

it("retires an acquisition proven not dispatched after final authority rejection", async () => {
  const f = await fixture();
  let checks = 0;
  await expect(
    f.controller.acquire(owner, "ios", 60000, {
      assertCurrent: () => {
        if (++checks === 4) {
          throw new Error("authority-revoked");
        }
      },
    }),
  ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(allocationCalls(f.calls)).toHaveLength(0);
  expect(await f.controller.status(owner, undefined, invocation)).toEqual({ state: "none" });
});
