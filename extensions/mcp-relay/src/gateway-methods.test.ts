import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../index.js";
import { consentAuthority, relayCaller } from "./caller.js";
import { registerMcpRelayConnectRoute, registerMcpRelayGatewayMethods } from "./gateway-methods.js";
import { createTransportFixture } from "./relay.test-helpers.js";
import type { RelayGrantAuthority } from "./state.js";

type Caller = NonNullable<GatewayRequestHandlerOptions["client"]>;
type Method = Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
const REQUEST_ID = "A".repeat(43);
const RELAY = "https://mcp.openclaw.ai";
const TEAM: OpenClawConfig = {
  gateway: {
    auth: { mode: "trusted-proxy" },
    roles: {
      default: "member",
      definitions: {
        member: {
          agents: "*",
          scopes: ["operator.read", "operator.write"],
          sessions: { others: "none" },
        },
      },
    },
  },
};

function caller(scopes = ["operator.read", "operator.write"], profileId?: string): Caller {
  return {
    connect: {
      minProtocol: 3,
      maxProtocol: 3,
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
      role: "operator",
      scopes,
    },
    ...(profileId
      ? {
          authenticatedUserProfile: {
            profileId,
            displayName: "Synthetic person",
            hasAvatar: false,
            updatedAt: 1,
          },
        }
      : {}),
  };
}

const fixtures: Awaited<ReturnType<typeof createTransportFixture>>[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.stop()));
});

async function harness(config = TEAM) {
  const transport = await createTransportFixture(undefined, { config: () => config });
  fixtures.push(transport);
  const methods = new Map<string, Method>();
  const registerGatewayMethod = vi.fn<OpenClawPluginApi["registerGatewayMethod"]>(
    (name, handler) => {
      methods.set(name, handler);
    },
  );
  const api = createTestPluginApi({ id: "mcp-relay", config, registerGatewayMethod });
  api.runtime = { ...api.runtime, config: { ...api.runtime.config, current: () => config } };
  registerMcpRelayGatewayMethods(api, () => transport.service);
  return {
    ...transport,
    registerGatewayMethod,
    async request(
      operation: string,
      params: Record<string, unknown>,
      client = caller(["operator.read", "operator.write"], "person-alice"),
      hasCurrentClientAuthority = () => true,
    ) {
      const method = `mcp-relay.${operation}`;
      const handler = methods.get(method);
      if (!handler) {
        throw new Error(`Missing method ${method}`);
      }
      const respond = vi.fn<GatewayRequestHandlerOptions["respond"]>();
      await handler({
        req: { type: "req", id: "synthetic-request", method, params },
        params,
        client,
        respond,
        isWebchatConnect: () => false,
        // These handlers consume the plugin runtime config, never a host request context.
        context: {} as GatewayRequestHandlerOptions["context"],
        hasCurrentClientAuthority,
      });
      expect(respond).toHaveBeenCalledTimes(1);
      return respond.mock.calls[0];
    },
    async addGrant(grantId: string, principal: RelayGrantAuthority["principal"]) {
      await transport.state.approveGrant(
        {
          grantId,
          clientId: `client-${grantId}`,
          clientName: "Synthetic client",
          createdAt: 1,
          principal,
          ceiling: ["operator.read", "operator.write"],
        },
        () => {},
      );
    },
  };
}

function denied(code: string) {
  return [false, undefined, expect.objectContaining({ details: { code } })];
}

describe("MCP relay Gateway consent and grant ownership", () => {
  it("binds approval to the authenticated caller and stores it before notifying the relay", async () => {
    const h = await harness();
    await h.ready();
    const approving = h.request("authorize.approve", { requestId: REQUEST_ID });
    const description = await h.socket.nextFrame();
    expect(description).toMatchObject({
      op: "authorize.describe",
      params: { requestId: REQUEST_ID },
    });
    h.socket.acknowledge(description, {
      kind: "oauth",
      clientName: "Synthetic client",
      redirectHost: "chatgpt.com",
      expiresAt: 601_000,
      profileId: "relay-selected-profile",
    });
    const approval = await h.socket.nextFrame();
    expect(approval).toMatchObject({
      op: "authorize.approve",
      params: {
        requestId: REQUEST_ID,
        principal: "person",
        principalLabel: "Synthetic person",
        ceiling: ["operator.read", "operator.write"],
      },
    });
    if (!isRecord(approval.params) || typeof approval.params.grantId !== "string") {
      throw new Error("Missing grant");
    }
    expect(h.state.getGrant(approval.params.grantId)).toMatchObject({
      principal: { kind: "person", profileId: "person-alice" },
      ceiling: ["operator.read", "operator.write"],
    });
    expect(JSON.stringify(h.socket.frames)).not.toContain("profileId");
    h.socket.acknowledge(approval);
    expect(await approving).toEqual([
      true,
      { continueUrl: `${RELAY}/oauth/continue?request=${REQUEST_ID}` },
    ]);
  });

  it("rejects caller-selected identities and ceilings outside the admitted role", async () => {
    const h = await harness();
    for (const params of [
      { profileId: "person-bob" },
      { principal: { kind: "person", profileId: "person-bob" } },
      { principal: { kind: "owner" } },
      { ceiling: ["operator.admin"] },
    ]) {
      expect(await h.request("authorize.approve", { requestId: REQUEST_ID, ...params })).toEqual(
        denied("invalid_params"),
      );
    }
    expect(h.socket.frames).toEqual([]);
  });

  it("denies a connection request without creating a grant", async () => {
    const h = await harness();
    await h.ready();
    const denying = h.request("authorize.deny", { requestId: REQUEST_ID });
    h.socket.acknowledge(await h.socket.nextFrame(), {
      kind: "link",
      clientName: "Synthetic client",
      redirectHost: "chatgpt.com",
      expiresAt: 601_000,
    });
    const denial = await h.socket.nextFrame();
    expect(denial).toMatchObject({ op: "authorize.deny", params: { requestId: REQUEST_ID } });
    h.socket.acknowledge(denial);
    expect(await denying).toEqual([
      true,
      { continueUrl: `${RELAY}/oauth/continue?request=${REQUEST_ID}` },
    ]);
    expect(await h.state.grants()).toEqual([]);
  });

  it.each(["expired", "foreign", "missing kind"])(
    "refuses %s consent without recording a grant",
    async (reason) => {
      const h = await harness();
      await h.ready();
      const approving = h.request("authorize.approve", { requestId: REQUEST_ID });
      const description = await h.socket.nextFrame();
      if (reason === "foreign") {
        h.socket.receive({
          type: "res",
          id: description.id,
          ok: false,
          error: { code: "not_found", message: "Foreign request" },
        });
      } else {
        h.socket.acknowledge(description, {
          kind: reason === "missing kind" ? undefined : "oauth",
          clientName: "Synthetic client",
          redirectHost: "chatgpt.com",
          expiresAt: reason === "expired" ? 1_000 : 601_000,
        });
      }
      expect(await approving).toEqual(denied("not_found"));
      expect(await h.state.grants()).toEqual([]);
    },
  );

  it("deletes a recorded grant if the relay rejects consent", async () => {
    const h = await harness();
    await h.ready();
    const approving = h.request("authorize.approve", { requestId: REQUEST_ID });
    h.socket.acknowledge(await h.socket.nextFrame(), {
      kind: "oauth",
      clientName: "Synthetic client",
      redirectHost: "chatgpt.com",
      expiresAt: 601_000,
    });
    const approval = await h.socket.nextFrame();
    h.socket.receive({
      type: "res",
      id: approval.id,
      ok: false,
      error: { code: "not_found", message: "Expired" },
    });
    const revocation = await h.socket.nextFrame();
    expect(revocation).toMatchObject({ op: "grant.revoke" });
    expect(await h.state.grants()).toEqual([]);
    h.socket.acknowledge(revocation);
    expect(await approving).toEqual(denied("not_found"));
  });

  it.each([
    { name: "no verified profile", client: caller(["operator.admin"]) },
    {
      name: "shared owner",
      client: {
        ...caller(["operator.admin"], "person-alice"),
        internal: { operatorRoleActor: { kind: "system" as const } },
      },
    },
    {
      name: "mismatched delegated profile",
      client: {
        ...caller(["operator.write"], "person-alice"),
        internal: { operatorRoleActor: { kind: "operator" as const, profileId: "person-bob" } },
      },
    },
  ])("refuses personless or mismatched Team pairing: $name", ({ client }) => {
    expect(() => relayCaller(client, TEAM)).toThrow("Connected apps");
  });

  it("requires admin for single-user owner pairing and defaults to read/write", () => {
    const config: OpenClawConfig = { gateway: { auth: { mode: "token" } } };
    expect(() => consentAuthority(relayCaller(caller(), config), undefined)).toThrow(
      "Your Gateway role cannot connect apps",
    );
    expect(consentAuthority(relayCaller(caller(["operator.admin"]), config), undefined)).toEqual({
      principal: { kind: "owner" },
      principalLabel: "Gateway owner",
      ceiling: ["operator.read", "operator.write"],
    });
  });

  it("lists and revokes only the caller's grants while admins can manage other people", async () => {
    const h = await harness();
    await h.addGrant("gr_alice", { kind: "person", profileId: "person-alice" });
    await h.addGrant("gr_bob", { kind: "person", profileId: "person-bob" });
    await h.addGrant("gr_owner", { kind: "owner" });
    expect(await h.request("grants", {})).toMatchObject([
      true,
      {
        grants: [{ grantId: "gr_alice" }],
        caller: { canAdmin: false },
      },
    ]);
    expect(await h.request("revoke", { grantId: "gr_bob" })).toEqual(denied("not_found"));
    expect(h.state.getGrant("gr_bob")).toBeDefined();
    expect(await h.request("revoke", { grantId: "gr_alice" })).toEqual([
      true,
      { revoked: true, relayNotified: false },
    ]);
    expect(h.state.getGrant("gr_alice")).toBeUndefined();
    const admin = caller(["operator.admin"], "person-alice");
    expect(await h.request("grants", {}, admin)).toMatchObject([
      true,
      {
        grants: [{ grantId: "gr_bob" }, { grantId: "gr_owner" }],
      },
    ]);
    expect(await h.request("revoke", { grantId: "gr_bob" }, admin)).toMatchObject([
      true,
      { revoked: true },
    ]);
    expect(h.state.getGrant("gr_bob")).toBeUndefined();
  });

  it("rechecks caller authority after loading grants before revocation", async () => {
    const h = await harness();
    await h.addGrant("gr_alice", { kind: "person", profileId: "person-alice" });
    const grants = h.service.grants.bind(h.service);
    let current = true;
    vi.spyOn(h.service, "grants").mockImplementation(async (...args) => {
      const result = await grants(...args);
      current = false;
      return result;
    });
    expect(await h.request("revoke", { grantId: "gr_alice" }, undefined, () => current)).toEqual(
      denied("unavailable"),
    );
    expect(h.state.getGrant("gr_alice")).toBeDefined();
  });
});

describe("MCP relay connect entrypoint", () => {
  function routeHarness(basePath = "/control") {
    const routes = new Map<string, Parameters<OpenClawPluginApi["registerHttpRoute"]>[0]>();
    const api = createTestPluginApi({
      id: "mcp-relay",
      config: { gateway: { controlUi: { basePath } } },
      registerHttpRoute: (route) => {
        routes.set(route.path, route);
      },
    });
    registerMcpRelayConnectRoute(api, RELAY);
    return async (path: string, query: Record<string, string>, method = "GET") => {
      const route = routes.get(path);
      if (!route) {
        throw new Error(`Missing route ${path}`);
      }
      const socket = new Socket();
      const request = new IncomingMessage(socket);
      request.url = `${path}?${new URLSearchParams(query)}`;
      request.method = method;
      const response = new ServerResponse(request);
      try {
        await route.handler(request, response);
        return { status: response.statusCode, headers: response.getHeaders() };
      } finally {
        socket.destroy();
      }
    };
  }

  it.each(["/mcp-relay/connect", "/control/mcp-relay/connect"])(
    "redirects %s to the native tab under normal Control UI authentication",
    async (path) => {
      const request = routeHarness();
      const result = await request(path, {
        request: REQUEST_ID,
        relay: RELAY,
        next: "https://evil.invalid",
      });
      expect(result).toEqual({
        status: 303,
        headers: {
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          location: `/control/plugin?plugin=mcp-relay&id=connected-apps&p.request=${REQUEST_ID}`,
        },
      });
    },
  );

  it.each([
    { query: { request: REQUEST_ID, relay: "https://foreign.invalid" }, method: "GET" },
    { query: { request: "invalid", relay: RELAY }, method: "GET" },
    { query: { request: REQUEST_ID, relay: RELAY }, method: "POST" },
  ])(
    "rejects malformed or foreign consent links without redirecting: %j",
    async ({ query, method }) => {
      const result = await routeHarness()("/mcp-relay/connect", query, method);
      expect(result.status).toBe(400);
      expect(result.headers.location).toBeUndefined();
    },
  );

  it("advertises the matching Connected apps tab without starting the relay", () => {
    const api = createTestPluginApi({ id: "mcp-relay" });
    const register = vi.spyOn(api.session.controls, "registerControlUiDescriptor");
    plugin.register?.(api);
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "tab",
        id: "connected-apps",
        label: "Connected apps",
        requiredScopes: ["operator.read"],
      }),
    );
  });
});
