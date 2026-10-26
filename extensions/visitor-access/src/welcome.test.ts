import assert from "node:assert/strict";
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

const readyResult = (sessionKey: unknown) => ({
  status: "ready",
  sessionKey,
  agentId: "main",
  created: true,
});

/** In-memory Gateway with the create-or-adopt and replay semantics of the real methods. */
async function welcomeHarness(grants: VisitorGrant[], config: OpenClawConfig = gatewayConfig) {
  const fixture = visitorFixture({ grants, gatewayConfig: config, emails: [EMAIL] });
  await fixture.service.initialize();
  const sessions = new Map<string, Record<string, unknown>>();
  const messages = new Map<string, Parameters<PluginRuntime["gateway"]["appendAgentMessage"]>[0]>();
  const gateway = {
    request: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      assert(typeof params?.key === "string");
      if (method === "sessions.describe") {
        return { session: sessions.has(params.key) ? { key: params.key } : null };
      }
      assert.equal(method, "sessions.create");
      if (!sessions.has(params.key)) {
        sessions.set(params.key, params);
      }
      return { ok: true, key: params.key };
    }) as unknown as PluginRuntime["gateway"]["request"],
    appendAgentMessage: vi.fn<PluginRuntime["gateway"]["appendAgentMessage"]>(async (message) => {
      assert(sessions.has(message.sessionKey), "session not found");
      const replayed = messages.has(message.idempotencyKey);
      messages.set(message.idempotencyKey, message);
      return { messageId: `message-${message.idempotencyKey}`, replayed };
    }),
  };
  const logger = { warn: vi.fn() };
  const restart = () => new VisitorWelcome(fixture.service, gateway, () => config, logger);
  const creates = () =>
    vi.mocked(gateway.request).mock.calls.filter(([method]) => method === "sessions.create");
  const welcome = restart();
  const ensure = (grant = grants[0], profile: Parameters<typeof guestClient>[1] = SAM) => {
    assert(grant, "welcome fixture requires a grant");
    return welcome.ensure(guestClient(grant.grantId!, profile));
  };
  return { fixture, sessions, messages, gateway, creates, welcome, restart, ensure };
}

describe("visitor-access.welcome.ensure", () => {
  useVisitorFixtures();

  it("registers the pull method for the restricted guest role", async () => {
    const methods = new Map<string, Parameters<OpenClawPluginApi["registerGatewayMethod"]>>();
    const { fixture } = await welcomeHarness([]);
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
    const h = await welcomeHarness([grant]);
    const result = await h.ensure();

    expect(result).toEqual(
      readyResult(expect.stringMatching(/^agent:main:dashboard:[0-9a-f-]{36}$/u)),
    );
    const sessionKey = result.status === "ready" ? result.sessionKey : "";
    expect(h.creates()).toEqual([
      ["sessions.create", { key: sessionKey, agentId: "main", displayName: "Welcome, Sam Rivera" }],
    ]);
    const message = h.gateway.appendAgentMessage.mock.calls[0]![0];
    expect(message).toMatchObject({
      sessionKey,
      agentId: "main",
      mentions: [{ profileId: JOSH.profileId, start: 34, end: 39 }],
      idempotencyKey: `visitor-welcome:${grant.grantId}`,
    });
    expect(message.text.slice(34, 39)).toBe("@Josh");
    expect(message.text).toMatch(
      /Welcome to OpenClaw, Sam Rivera\.[\s\S]*@Josh invited you.*2026-11-06 12:00 UTC/,
    );
    expect(message.text).toContain(
      "Note from Josh:\nWould love your eyes on the guest onboarding flow.",
    );
    expect(message.text).toMatch(
      /own session with Roboclaw[\s\S]*start your own sessions with Roboclaw[\s\S]*private sandbox[\s\S]*read other people's sessions/,
    );
    expect(h.fixture.grants.get(EMAIL)?.onboarding).toEqual({
      state: "ready",
      welcomeSessionKey: sessionKey,
      updatedAt: NOW + 2,
    });

    // Reloads, a restart, and renewal return the same session without setting it up again.
    await expect(h.restart().ensure(guestClient(grant.grantId!))).resolves.toEqual({
      ...result,
      created: false,
    });
    const invitedBy = { profileId: "replacement-inviter" };
    await h.fixture.service.invite(
      { email: EMAIL, days: 30, note: "Updated note" },
      { ...h.fixture.authority, invitedBy },
    );
    expect(h.fixture.grants.get(EMAIL)).toMatchObject({ invitedBy, note: "Updated note" });
    expect(await h.ensure()).toEqual({ ...result, created: false });
    expect(h.creates()).toHaveLength(1);
    expect(h.gateway.appendAgentMessage).toHaveBeenCalledOnce();
  });

  it("returns not_applicable without an active visitor grant for this connection", async () => {
    const grant = visitorGrant(EMAIL);
    const h = await welcomeHarness([grant]);
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
      expect(await h.welcome.ensure(client as Client)).toEqual({ status: "not_applicable" });
    }
    vi.setSystemTime(NOW + DAY_MS);
    expect(await h.ensure()).toEqual({ status: "not_applicable" });
    expect(h.gateway.request).not.toHaveBeenCalled();
  });

  it("answers concurrent calls with pending while one call holds the reservation", async () => {
    const grant = pendingWelcomeGrant();
    const h = await welcomeHarness([grant]);
    const [first, competing, second] = await Promise.all([
      h.ensure(),
      h.restart().ensure(guestClient(grant.grantId!)),
      h.ensure(),
    ]);

    expect(first).toMatchObject({ status: "ready", created: true });
    expect(second).toEqual({ status: "pending", retryAfterMs: 1000 });
    expect(competing).toEqual(second);
    expect(await h.ensure()).toMatchObject({ status: "ready", created: false });
  });

  it("adopts an existing pending reservation on startup", async () => {
    const sessionKey = "agent:main:dashboard:reserved";
    const grant = visitorGrant(EMAIL, {
      onboarding: { state: "pending", welcomeSessionKey: sessionKey, updatedAt: NOW },
    });
    const restarted = await welcomeHarness([grant]);
    restarted.sessions.set(sessionKey, { key: sessionKey });

    expect(await restarted.ensure()).toEqual(readyResult(sessionKey));
    expect(restarted.gateway.request).toHaveBeenCalledWith(
      "sessions.create",
      expect.objectContaining({ key: sessionKey }),
    );
    expect(restarted.messages.size).toBe(1);
  });

  it("gives a grant recorded by v2026.10.6, without inviter or onboarding, a generic welcome", async () => {
    // Shape the v2026.10.6 visitor_invite tool recorded before onboarding metadata existed.
    const legacy = visitorGrant(EMAIL, { invitedVia: "agent:main:maintainer", expiresAt: null });
    const h = await welcomeHarness([legacy], {
      gateway: {
        roles: { default: "guest", definitions: { guest: { ...guestRole, agents: "*" } } },
      },
    });
    expect(await h.ensure(legacy, { profileId: "profile-sam" })).toMatchObject({
      status: "ready",
      agentId: "main",
      created: true,
    });
    expect(h.gateway.request).toHaveBeenCalledWith(
      "sessions.create",
      expect.objectContaining({ displayName: "Welcome" }),
    );
    const message = h.gateway.appendAgentMessage.mock.calls[0]![0];
    expect(message).toMatchObject({
      sessionKey: expect.any(String),
      agentId: "main",
      idempotencyKey: `visitor-welcome:${legacy.grantId}`,
    });
    expect(message).not.toHaveProperty("mentions");
    expect(message.text).toMatch(
      /^Welcome to OpenClaw\.[\s\S]*You were invited as a guest.*does not expire/,
    );
    expect(message.text).toMatch(
      /own session with main[\s\S]*own sessions with any agent on this Gateway/,
    );
  });

  it("keeps one welcome session when access is renewed during setup or after a failure", async () => {
    const grant = pendingWelcomeGrant();
    const h = await welcomeHarness([grant]);
    const gate = visitorGate();
    const errorDetail = "transcript write failed: " + "e".repeat(600);
    h.gateway.appendAgentMessage.mockImplementationOnce(async () => {
      await gate.wait();
      throw new Error(errorDetail);
    });

    const setup = h.ensure();
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
    expect(await setup).toEqual({
      status: "failed",
      retryable: true,
      message: "Your welcome session could not be set up yet. Reload to try again.",
    });
    const failed = h.fixture.grants.get(EMAIL)?.onboarding;
    expect(failed).toMatchObject({
      state: "failed",
      welcomeSessionKey: reserved?.welcomeSessionKey,
      error: errorDetail.slice(0, 500),
    });

    await h.fixture.invite({ email: EMAIL, days: 60 });
    expect(h.fixture.grants.get(EMAIL)?.onboarding).toEqual(failed);
    await expect(h.ensure()).resolves.toEqual(readyResult(reserved?.welcomeSessionKey));
    expect(h.sessions.size).toBe(1);
    expect(h.messages.size).toBe(1);
  });

  it.each(["append", "ready commit"] as const)(
    "ends setup cleanly when access is revoked before the %s",
    async (step) => {
      const grant = pendingWelcomeGrant();
      const h = await welcomeHarness([grant]);
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

      const setup = h.ensure();
      await gate.entered;
      await h.fixture.revoke({ email: EMAIL });
      gate.release();

      await expect(setup).resolves.toEqual({ status: "not_applicable" });
      expect(h.fixture.grants.has(EMAIL)).toBe(false);
      await h.fixture.invite({ email: EMAIL, days: 7 });
      const reinvited = h.fixture.grants.get(EMAIL)!;
      expect(reinvited.grantId).not.toBe(grant.grantId);
      expect(reinvited.onboarding).toEqual({ state: "pending", updatedAt: NOW });
      expect(await h.ensure(reinvited)).toMatchObject({ status: "ready", created: true });
      // The session created before revocation stays the guest's; the new invitation gets its own.
      expect(h.sessions.size).toBe(2);
      expect(h.messages.size).toBe(step === "append" ? 1 : 2);
    },
  );

  it("does not recreate a deleted welcome session or send the guest to it", async () => {
    const grant = pendingWelcomeGrant();
    const h = await welcomeHarness([grant]);
    const first = await h.ensure();
    expect(first).toMatchObject({ status: "ready", created: true });

    h.sessions.clear();
    expect(await h.ensure()).toEqual({ status: "not_applicable" });
    // The guest role holds only session scopes; the read it implies must be requested.
    expect(h.gateway.request).toHaveBeenLastCalledWith(
      "sessions.describe",
      { key: first.status === "ready" ? first.sessionKey : "", agentId: "main" },
      { scopes: ["operator.sessions.read"] },
    );
    await h.fixture.invite({ email: EMAIL, days: 30 });
    expect(await h.restart().ensure(guestClient(grant.grantId!))).toEqual({
      status: "not_applicable",
    });
    expect(h.creates()).toHaveLength(1);
    expect(h.fixture.grants.get(EMAIL)?.onboarding).toMatchObject({
      state: "ready",
      welcomeSessionKey: first.status === "ready" ? first.sessionKey : "",
    });
  });

  it("returns copyable invitation text and keeps the note in it on renewal", async () => {
    const fixture = visitorFixture();
    await fixture.service.initialize();
    const signInUrl = "https://team.example.com";
    const invitationText = (expiry: string) =>
      [
        "Josh invited you to OpenClaw.",
        `Sign in at ${signInUrl} with the email ${EMAIL}.`,
        `Your access expires on ${expiry}.`,
        "",
        "Note from Josh:",
        "Start here: https://team.example.com/chat/welcome",
      ].join("\n");

    const invited = await fixture.service.invite(
      { email: EMAIL, days: 7, note: "  Start here: https://team.example.com/chat/welcome\n" },
      { ...fixture.authority, invitedBy: JOSH, signInUrl },
    );
    expect(invited.details).toMatchObject({
      signInUrl,
      noteStored: true,
      invitationText: invitationText("2026-09-04 12:00 UTC"),
    });
    expect(invited.text).toContain("Inviter note stored.");
    expect(invited.text.endsWith(`\n${invitationText("2026-09-04 12:00 UTC")}`)).toBe(true);
    expect(invited.details.invitationText).not.toContain(invited.details.grantId);

    vi.setSystemTime(NOW + DAY_MS);
    const renewed = await fixture.service.invite(
      { email: EMAIL, days: 7 },
      { ...fixture.authority, signInUrl },
    );
    expect(renewed.details.invitationText).toBe(invitationText("2026-09-05 12:00 UTC"));
    expect(renewed.text).toContain("Existing inviter note kept.");
  });

  it("degrades invitation text without a sign-in URL, inviter, or note", async () => {
    const fixture = visitorFixture({ githubLogin: "octocat" });
    await fixture.service.initialize();

    const invited = await fixture.service.invite(
      { github: "OctoCat", forever: true },
      fixture.authority,
    );

    expect(invited.details).not.toHaveProperty("signInUrl");
    expect(invited.details).toMatchObject({
      noteStored: false,
      invitationText: [
        "You're invited to OpenClaw.",
        "Ask the person who invited you for the OpenClaw sign-in address, then sign in with your GitHub account @octocat.",
        "Your access does not expire.",
      ].join("\n"),
    });
    expect(invited.text).toContain("No sign-in URL: set gateway.publicOrigin");
    expect(invited.text).not.toContain("inviter note");
  });

  it("lists each invitation's welcome-session progress for staff", async () => {
    const grants = (["ready", "failed", "pending", undefined] as const).map((state, index) =>
      visitorGrant(`${index}@example.com`, {
        onboarding: state && {
          state,
          updatedAt: NOW,
          ...(state !== "pending" ? { welcomeSessionKey: `agent:main:dashboard:${state}` } : {}),
          ...(state === "failed" ? { error: "transcript write failed" } : {}),
        },
      }),
    );
    const fixture = visitorFixture({ grants, emails: grants.map(({ email }) => email) });

    const list = await fixture.list();

    expect(list.details.grants.map((row) => row.welcome)).toEqual([
      { state: "ready", sessionKey: "agent:main:dashboard:ready" },
      { state: "failed", sessionKey: "agent:main:dashboard:failed" },
      { state: "pending" },
      undefined,
    ]);
    expect(list.text).toContain("| managed | welcome ready agent:main:dashboard:ready |");
    expect(list.text).toContain("| managed | welcome failed agent:main:dashboard:failed |");
    expect(list.text).toContain("| managed | welcome pending |");
    expect(list.text).toMatch(/3@example\.com[^\n]*\| managed \| Gateway access:/);
    expect(list.text).not.toContain("transcript write failed");
  });

  it("does not persist onboarding when the caller ends during the grant read", async () => {
    const grant = visitorGrant(EMAIL);
    const fixture = visitorFixture({ grants: [grant] });
    await fixture.service.initialize();
    const gate = visitorGate();
    const lookup = fixture.store.lookup.bind(fixture.store);
    fixture.store.lookup = async (key) => {
      await gate.wait();
      return lookup(key);
    };
    const update = fixture.service.compareAndSetOnboarding({
      grantId: grant.grantId!,
      expected: null,
      next: { state: "pending" },
      assertCurrent: fixture.authority.assertCurrent,
    });
    await gate.entered;
    fixture.revokeAuthority();
    gate.release();
    await expect(update).rejects.toThrow(/no longer current/);
    expect(fixture.grants.get(EMAIL)).toEqual(grant);
  });
});
