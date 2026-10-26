import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../api.js";
import plugin from "../index.js";
import type { VisitorGrant } from "./grant-record.js";
import {
  DAY_MS,
  NOW,
  guestRole,
  staffRole,
  useVisitorFixtures,
  visitorFixture,
  visitorGate,
  visitorGrant,
} from "./visitors.test-support.js";
import { VisitorWelcome } from "./welcome.js";

const EMAIL = "sam@example.com";
const JOSH = { profileId: "profile-josh", label: "Josh" };
const SAM = { profileId: "profile-sam", displayName: "Sam Rivera" };
const gatewayConfig: OpenClawConfig = {
  agents: { entries: { main: { name: "Roboclaw" }, ops: {} } },
  gateway: { roles: { default: "guest", definitions: { guest: guestRole, staff: staffRole } } },
};

type Client = GatewayRequestHandlerOptions["client"];

function pendingWelcomeGrant() {
  return visitorGrant(EMAIL, {
    invitedBy: JOSH,
    onboarding: { state: "pending", updatedAt: NOW },
  });
}

function guestClient(grantId: string, profile: { profileId: string; displayName?: string } = SAM) {
  return {
    authenticatedUserProfile: profile,
    internal: {
      operatorAccessAuthority: { gatewayAccessGrant: { pluginId: "visitor-access", grantId } },
    },
  } as unknown as Client;
}

/** In-memory Gateway with the create-or-adopt and replay semantics of the real methods. */
function welcomeHarness(grants: VisitorGrant[], config: OpenClawConfig = gatewayConfig) {
  const fixture = visitorFixture({ grants, gatewayConfig: config, emails: [EMAIL] });
  const sessions = new Map<string, Record<string, unknown>>();
  const messages = new Map<string, Parameters<PluginRuntime["gateway"]["appendAgentMessage"]>[0]>();
  const gateway = {
    request: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (typeof params?.key !== "string") {
        throw new Error(`Unexpected Gateway request ${method}`);
      }
      if (method === "sessions.describe") {
        return { session: sessions.has(params.key) ? { key: params.key } : null };
      }
      if (method !== "sessions.create") {
        throw new Error(`Unexpected Gateway request ${method}`);
      }
      if (!sessions.has(params.key)) {
        sessions.set(params.key, params);
      }
      return { ok: true, key: params.key };
    }) as unknown as PluginRuntime["gateway"]["request"],
    appendAgentMessage: vi.fn<PluginRuntime["gateway"]["appendAgentMessage"]>(async (message) => {
      if (!sessions.has(message.sessionKey)) {
        throw new Error("session not found");
      }
      const replayed = messages.has(message.idempotencyKey);
      messages.set(message.idempotencyKey, message);
      return { messageId: `message-${message.idempotencyKey}`, replayed };
    }),
  };
  const logger = { warn: vi.fn() };
  const restart = () => new VisitorWelcome(fixture.service, gateway, () => config, logger);
  const creates = () =>
    vi.mocked(gateway.request).mock.calls.filter(([method]) => method === "sessions.create");
  return { fixture, sessions, messages, gateway, creates, welcome: restart(), restart };
}

describe("visitor-access.welcome.ensure", () => {
  useVisitorFixtures();

  it("registers the pull method for the restricted guest role", async () => {
    const methods = new Map<string, Parameters<OpenClawPluginApi["registerGatewayMethod"]>>();
    const { fixture } = welcomeHarness([]);
    const api = createTestPluginApi({
      id: "visitor-access",
      pluginConfig: { accountId: "test-account", appId: "test-app", apiToken: "test-token" },
      registerGatewayMethod: (...registration) => void methods.set(registration[0], registration),
    });
    api.runtime = {
      state: { openKeyedStore: () => fixture.store },
      config: { current: () => gatewayConfig },
      gateway: {},
    } as unknown as PluginRuntime;
    plugin.register(api);
    const [, handler, options] = methods.get("visitor-access.welcome.ensure") ?? [];
    expect(options).toEqual({ scope: "operator.sessions.write", profileAccess: "required" });
    const respond = vi.fn();
    await handler?.({
      params: {},
      client: { authenticatedUserProfile: JOSH, internal: {} },
      respond,
    } as unknown as GatewayRequestHandlerOptions);
    expect(respond).toHaveBeenCalledWith(true, { status: "not_applicable" });
  });

  it("creates one guest-owned welcome session with an agent message naming the inviter", async () => {
    const grant = visitorGrant(EMAIL, {
      invitedBy: JOSH,
      note: "Would love your eyes on the guest onboarding flow.",
      onboarding: { state: "pending", updatedAt: NOW },
      expiresAt: Date.parse("2026-11-06T12:00:00.000Z"),
    });
    const h = welcomeHarness([grant]);
    await h.fixture.service.initialize();

    const result = await h.welcome.ensure(guestClient(grant.grantId!));

    expect(result).toEqual({
      status: "ready",
      sessionKey: expect.stringMatching(/^agent:main:dashboard:[0-9a-f-]{36}$/u),
      agentId: "main",
      created: true,
    });
    const sessionKey = result.status === "ready" ? result.sessionKey : "";
    // The caller-bound request is the guest's own sessions.create.
    expect(h.creates()).toEqual([
      ["sessions.create", { key: sessionKey, agentId: "main", displayName: "Welcome, Sam Rivera" }],
    ]);
    const text = [
      "Welcome to OpenClaw, Sam Rivera.",
      "",
      "@Josh invited you. Your guest access runs through 2026-11-06 12:00 UTC.",
      "",
      "Note from Josh:",
      "Would love your eyes on the guest onboarding flow.",
      "",
      "This is your own session with Roboclaw. As a guest you can:",
      "- start your own sessions with Roboclaw",
      "- have Roboclaw work in a private sandbox",
      "- read other people's sessions",
    ].join("\n");
    expect(h.gateway.appendAgentMessage).toHaveBeenCalledExactlyOnceWith({
      sessionKey,
      agentId: "main",
      text,
      mentions: [{ profileId: JOSH.profileId, start: 34, end: 39 }],
      idempotencyKey: `visitor-welcome:${grant.grantId}`,
    });
    expect(text.slice(34, 39)).toBe("@Josh");
    expect(h.fixture.grants.get(EMAIL)?.onboarding).toEqual({
      state: "ready",
      welcomeSessionKey: sessionKey,
      // Reservation, then ready.
      updatedAt: NOW + 2,
    });

    // Reloads, a restart, and renewal return the same session without setting it up again.
    await expect(h.restart().ensure(guestClient(grant.grantId!))).resolves.toEqual({
      ...result,
      created: false,
    });
    await h.fixture.invite({ email: EMAIL, days: 30 });
    await expect(h.welcome.ensure(guestClient(grant.grantId!))).resolves.toEqual({
      ...result,
      created: false,
    });
    expect(h.creates()).toHaveLength(1);
    expect(h.gateway.appendAgentMessage).toHaveBeenCalledOnce();
  });

  it("returns not_applicable without an active visitor grant for this connection", async () => {
    const grant = visitorGrant(EMAIL);
    const h = welcomeHarness([grant]);
    await h.fixture.service.initialize();
    const staff = { authenticatedUserProfile: JOSH, internal: { operatorAccessAuthority: null } };
    const owner = { authenticatedUserProfile: { profileId: "gateway-owner" }, internal: {} };
    for (const client of [
      null,
      staff,
      owner,
      guestClient("00000000-0000-4000-8000-000000000000"),
      {
        ...guestClient(grant.grantId!),
        internal: {
          operatorAccessAuthority: {
            gatewayAccessGrant: { pluginId: "other-access", grantId: grant.grantId },
          },
        },
      },
    ]) {
      await expect(h.welcome.ensure(client as Client)).resolves.toEqual({
        status: "not_applicable",
      });
    }
    vi.setSystemTime(NOW + DAY_MS);
    await expect(h.welcome.ensure(guestClient(grant.grantId!))).resolves.toEqual({
      status: "not_applicable",
    });
    expect(h.gateway.request).not.toHaveBeenCalled();
  });

  it("answers concurrent calls with pending while one call holds the reservation", async () => {
    const grant = pendingWelcomeGrant();
    const h = welcomeHarness([grant]);
    await h.fixture.service.initialize();

    const [first, second] = await Promise.all([
      h.welcome.ensure(guestClient(grant.grantId!)),
      h.welcome.ensure(guestClient(grant.grantId!)),
    ]);

    expect(first).toMatchObject({ status: "ready", created: true });
    expect(second).toEqual({ status: "pending", retryAfterMs: 1000 });
    await expect(h.welcome.ensure(guestClient(grant.grantId!))).resolves.toMatchObject({
      status: "ready",
      created: false,
    });
    expect(h.sessions.size).toBe(1);
    expect(h.messages.size).toBe(1);
  });

  it("resumes a failed or interrupted setup against the reserved session key", async () => {
    const grant = pendingWelcomeGrant();
    const h = welcomeHarness([grant]);
    await h.fixture.service.initialize();
    h.gateway.appendAgentMessage.mockRejectedValueOnce(new Error("transcript write failed: disk"));

    await expect(h.welcome.ensure(guestClient(grant.grantId!))).resolves.toEqual({
      status: "failed",
      retryable: true,
      message: "Your welcome session could not be set up yet. Reload to try again.",
    });
    const reserved = h.fixture.grants.get(EMAIL)?.onboarding;
    expect(reserved).toMatchObject({
      state: "failed",
      welcomeSessionKey: expect.stringMatching(/^agent:main:dashboard:/u),
      error: "transcript write failed: disk",
    });

    // A process stopping after the reservation leaves it pending; a fresh service resumes it.
    h.fixture.grants.set(EMAIL, {
      ...h.fixture.grants.get(EMAIL)!,
      onboarding: {
        state: "pending",
        welcomeSessionKey: reserved?.welcomeSessionKey,
        updatedAt: NOW + 5,
      },
    });
    h.fixture.service.close();
    const restarted = welcomeHarness([h.fixture.grants.get(EMAIL)!]);
    await restarted.fixture.service.initialize();
    for (const [key, session] of h.sessions) {
      restarted.sessions.set(key, session);
    }

    await expect(restarted.welcome.ensure(guestClient(grant.grantId!))).resolves.toEqual({
      status: "ready",
      sessionKey: reserved?.welcomeSessionKey,
      agentId: "main",
      created: true,
    });
    expect(restarted.gateway.request).toHaveBeenCalledWith(
      "sessions.create",
      expect.objectContaining({ key: reserved?.welcomeSessionKey }),
    );
    expect(restarted.sessions.size).toBe(1);
    expect(restarted.messages.size).toBe(1);
  });

  it("gives a grant recorded by v2026.10.6, without inviter or onboarding, a generic welcome", async () => {
    // Shape the v2026.10.6 visitor_invite tool recorded before onboarding metadata existed.
    const legacy = visitorGrant(EMAIL, { invitedVia: "agent:main:maintainer", expiresAt: null });
    const config: OpenClawConfig = {
      gateway: {
        roles: {
          default: "guest",
          definitions: {
            guest: { ...guestRole, agents: "*" },
          },
        },
      },
    };
    const h = welcomeHarness([legacy], config);
    await h.fixture.service.initialize();

    await expect(
      h.welcome.ensure(guestClient(legacy.grantId!, { profileId: "profile-sam" })),
    ).resolves.toMatchObject({ status: "ready", agentId: "main", created: true });
    expect(h.gateway.request).toHaveBeenCalledWith(
      "sessions.create",
      expect.objectContaining({ displayName: "Welcome" }),
    );
    expect(h.gateway.appendAgentMessage.mock.calls[0]?.[0]).toEqual({
      sessionKey: expect.any(String),
      agentId: "main",
      text: [
        "Welcome to OpenClaw.",
        "",
        "You were invited as a guest. Your guest access does not expire.",
        "",
        "This is your own session with main. As a guest you can:",
        "- start your own sessions with any agent on this Gateway",
        "- have main work in a private sandbox",
        "- read other people's sessions",
      ].join("\n"),
      idempotencyKey: `visitor-welcome:${legacy.grantId}`,
    });
  });

  it("keeps one welcome session when access is renewed during setup or after a failure", async () => {
    const grant = pendingWelcomeGrant();
    const h = welcomeHarness([grant]);
    await h.fixture.service.initialize();
    const gate = visitorGate();
    h.gateway.appendAgentMessage.mockImplementationOnce(async () => {
      await gate.wait();
      throw new Error("transcript write failed: disk");
    });

    const setup = h.welcome.ensure(guestClient(grant.grantId!));
    await gate.entered;
    const reserved = h.fixture.grants.get(EMAIL)?.onboarding;
    expect(reserved).toMatchObject({ state: "pending", welcomeSessionKey: expect.any(String) });
    // Renewal mid-setup keeps the reservation, so the in-flight setup can still record it.
    await h.fixture.invite({ email: EMAIL, days: 30 });
    expect(h.fixture.grants.get(EMAIL)).toMatchObject({
      grantId: grant.grantId,
      onboarding: reserved,
    });
    gate.release();
    await expect(setup).resolves.toMatchObject({ status: "failed" });
    const failed = h.fixture.grants.get(EMAIL)?.onboarding;
    expect(failed).toMatchObject({
      state: "failed",
      welcomeSessionKey: reserved?.welcomeSessionKey,
    });

    await h.fixture.invite({ email: EMAIL, days: 60 });
    expect(h.fixture.grants.get(EMAIL)?.onboarding).toEqual(failed);
    await expect(h.welcome.ensure(guestClient(grant.grantId!))).resolves.toEqual({
      status: "ready",
      sessionKey: reserved?.welcomeSessionKey,
      agentId: "main",
      created: true,
    });
    expect(h.sessions.size).toBe(1);
    expect(h.messages.size).toBe(1);
  });

  it.each(["append", "ready commit"] as const)(
    "ends setup cleanly when access is revoked before the %s",
    async (step) => {
      const grant = pendingWelcomeGrant();
      const h = welcomeHarness([grant]);
      await h.fixture.service.initialize();
      const gate = visitorGate();
      const append = h.gateway.appendAgentMessage.getMockImplementation()!;
      h.gateway.appendAgentMessage.mockImplementationOnce(async (message) => {
        await gate.wait();
        if (step === "append") {
          // The Gateway refuses the guest's writes once the admitted grant ends.
          throw new Error("Visitor access ended. Ask a maintainer to renew access.");
        }
        return await append(message);
      });

      const setup = h.welcome.ensure(guestClient(grant.grantId!));
      await gate.entered;
      await h.fixture.revoke({ email: EMAIL });
      gate.release();

      await expect(setup).resolves.toEqual({ status: "not_applicable" });
      expect(h.fixture.grants.has(EMAIL)).toBe(false);
      await h.fixture.invite({ email: EMAIL, days: 7 });
      const reinvited = h.fixture.grants.get(EMAIL)!;
      expect(reinvited.grantId).not.toBe(grant.grantId);
      expect(reinvited.onboarding).toEqual({ state: "pending", updatedAt: NOW });
      await expect(h.welcome.ensure(guestClient(reinvited.grantId!))).resolves.toMatchObject({
        status: "ready",
        created: true,
      });
      // The session created before revocation stays the guest's; the new invitation gets its own.
      expect(h.sessions.size).toBe(2);
      expect(h.messages.size).toBe(step === "append" ? 1 : 2);
    },
  );

  it("does not recreate a deleted welcome session or send the guest to it", async () => {
    const grant = pendingWelcomeGrant();
    const h = welcomeHarness([grant]);
    await h.fixture.service.initialize();
    const first = await h.welcome.ensure(guestClient(grant.grantId!));
    expect(first).toMatchObject({ status: "ready", created: true });

    h.sessions.clear();
    await expect(h.welcome.ensure(guestClient(grant.grantId!))).resolves.toEqual({
      status: "not_applicable",
    });
    // The guest role holds only session scopes; the read it implies must be requested.
    expect(h.gateway.request).toHaveBeenLastCalledWith(
      "sessions.describe",
      { key: first.status === "ready" ? first.sessionKey : "", agentId: "main" },
      { scopes: ["operator.sessions.read"] },
    );
    await h.fixture.invite({ email: EMAIL, days: 30 });
    await expect(h.restart().ensure(guestClient(grant.grantId!))).resolves.toEqual({
      status: "not_applicable",
    });
    expect(h.creates()).toHaveLength(1);
    expect(h.fixture.grants.get(EMAIL)?.onboarding).toMatchObject({
      state: "ready",
      welcomeSessionKey: first.status === "ready" ? first.sessionKey : "",
    });
  });

  it("starts a new welcome session for a new invitation after the old one expired", async () => {
    const grant = pendingWelcomeGrant();
    const h = welcomeHarness([grant]);
    await h.fixture.service.initialize();
    const first = await h.welcome.ensure(guestClient(grant.grantId!));

    vi.setSystemTime(NOW + 2 * DAY_MS);
    await h.fixture.invite({ email: EMAIL, days: 7 });
    const renewed = h.fixture.grants.get(EMAIL)!;
    expect(renewed.grantId).not.toBe(grant.grantId);

    const second = await h.welcome.ensure(guestClient(renewed.grantId!));
    expect(second).toMatchObject({ status: "ready", created: true });
    expect(second).not.toMatchObject({
      sessionKey: first.status === "ready" ? first.sessionKey : "",
    });
    expect(h.sessions.size).toBe(2);
  });
});
