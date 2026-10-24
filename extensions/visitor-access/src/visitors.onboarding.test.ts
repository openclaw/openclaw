import { describe, expect, it, vi } from "vitest";
import {
  DAY_MS,
  NOW,
  useVisitorFixtures,
  visitorFixture,
  visitorGate,
  visitorGrant,
} from "./visitors.test-support.js";

const EMAIL = "visitor@example.com";
const JOSH = { profileId: "profile-josh", label: "Josh" };

describe("VisitorAccessService onboarding record", () => {
  useVisitorFixtures();

  it("records the trusted inviter, note, and pending onboarding and reloads them", async () => {
    const fixture = visitorFixture();
    await fixture.service.invite(
      { email: EMAIL, note: "  Start with the onboarding doc.\n" },
      { ...fixture.authority, invitedBy: JOSH },
    );

    expect(fixture.grants.get(EMAIL)).toMatchObject({
      invitedBy: JOSH,
      note: "  Start with the onboarding doc.\n",
      onboarding: { state: "pending", updatedAt: NOW },
    });
    fixture.service.close();
    const restarted = visitorFixture({ grants: [...fixture.grants.values()] });
    await restarted.service.initialize();
    expect(
      restarted.service.findActiveInvitation({ emails: [" Visitor@Example.com "] }),
    ).toMatchObject({
      grantId: fixture.grants.get(EMAIL)?.grantId,
      email: EMAIL,
      invitedBy: JOSH,
      note: "  Start with the onboarding doc.\n",
      onboarding: { state: "pending", updatedAt: NOW },
    });
  });

  it.each([{ note: "x".repeat(1001) }, { note: 7 }])(
    "rejects an invalid note before any provider write: %j",
    async (input) => {
      const fixture = visitorFixture();
      await expect(fixture.invite({ email: EMAIL, ...input })).rejects.toThrow(
        /note must be a string of at most 1000 characters/,
      );
      expect(fixture.grants.size).toBe(0);
      expect(fixture.mutations()).toEqual([]);
    },
  );

  it("keeps legacy grants working without onboarding metadata through renewal", async () => {
    const legacy = visitorGrant(EMAIL);
    const fixture = visitorFixture({ grants: [legacy], emails: [EMAIL] });
    await fixture.service.initialize();
    expect(() => fixture.authorize([EMAIL]).assertCurrent()).not.toThrow();
    expect(fixture.service.findActiveInvitation({ emails: [EMAIL] })).toEqual(legacy);

    await fixture.invite({ email: EMAIL, days: 3 });

    expect(fixture.grants.get(EMAIL)).toEqual({ ...legacy, expiresAt: NOW + 3 * DAY_MS });
    await expect(
      fixture.service.compareAndSetOnboarding({
        grantId: legacy.grantId!,
        expected: null,
        next: { state: "ready", welcomeSessionKey: "agent:roboclaw:welcome" },
      }),
    ).resolves.toEqual({
      applied: true,
      onboarding: { state: "ready", welcomeSessionKey: "agent:roboclaw:welcome", updatedAt: NOW },
    });
  });

  it("renewal keeps inviter, note, and ready onboarding unless new values are supplied", async () => {
    const fixture = visitorFixture();
    await fixture.service.initialize();
    await fixture.service.invite(
      { email: EMAIL, note: "Welcome!" },
      { ...fixture.authority, invitedBy: JOSH },
    );
    const invitation = fixture.service.findActiveInvitation({ emails: [EMAIL] })!;
    vi.setSystemTime(NOW + 1000);
    await fixture.service.compareAndSetOnboarding({
      grantId: invitation.grantId,
      expected: invitation.onboarding!,
      next: { state: "ready", welcomeSessionKey: "welcome-key", welcomeSessionId: "welcome-id" },
    });
    const ready = {
      state: "ready",
      welcomeSessionKey: "welcome-key",
      welcomeSessionId: "welcome-id",
      updatedAt: NOW + 1000,
    };

    await fixture.invite({ email: EMAIL, days: 30 });
    expect(fixture.grants.get(EMAIL)).toMatchObject({
      grantId: invitation.grantId,
      invitedBy: JOSH,
      note: "Welcome!",
      onboarding: ready,
      expiresAt: NOW + 1000 + 30 * DAY_MS,
    });

    const peter = { profileId: "profile-peter" };
    await fixture.service.invite(
      { email: EMAIL, note: "Updated note" },
      { ...fixture.authority, invitedBy: peter },
    );
    expect(fixture.grants.get(EMAIL)).toMatchObject({
      invitedBy: peter,
      note: "Updated note",
      onboarding: ready,
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
    expect(renewed.details).toMatchObject({
      outcome: "renewed",
      noteStored: true,
      invitationText: invitationText("2026-09-05 12:00 UTC"),
    });
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

  it("lets exactly one concurrent caller advance the same onboarding snapshot", async () => {
    const fixture = visitorFixture();
    await fixture.service.initialize();
    await fixture.invite({ email: EMAIL });
    const invitation = fixture.service.findActiveInvitation({ emails: [EMAIL] })!;
    const claim = (welcomeSessionKey: string) =>
      fixture.service.compareAndSetOnboarding({
        grantId: invitation.grantId,
        expected: invitation.onboarding!,
        next: { state: "pending", welcomeSessionKey },
      });

    const [first, second] = await Promise.all([claim("first"), claim("second")]);

    const winner = { state: "pending", welcomeSessionKey: "first", updatedAt: NOW + 1 };
    expect(first).toEqual({ applied: true, onboarding: winner });
    expect(second).toEqual({ applied: false, reason: "conflict", onboarding: winner });
    expect(fixture.grants.get(EMAIL)?.onboarding).toEqual(winner);
    expect(fixture.service.findActiveInvitation({ emails: [EMAIL] })?.onboarding).toEqual(winner);
  });

  it("finds an active GitHub invitation past an expired email and rejects input-supplied inviter", async () => {
    const github = visitorGrant(42);
    const fixture = visitorFixture({ grants: [visitorGrant(EMAIL, { expiresAt: NOW }), github] });
    await fixture.service.initialize();
    expect(
      fixture.service.findActiveInvitation({ emails: [EMAIL], githubAccountIds: [7, 42] }),
    ).toEqual(github);
    await expect(fixture.invite({ email: EMAIL, invitedBy: JOSH })).rejects.toThrow(
      /Invalid visitor input/,
    );
    expect(fixture.mutations()).toEqual([]);
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

  it("records a bounded failure and refuses inactive grants", async () => {
    const fixture = visitorFixture();
    await fixture.service.initialize();
    await fixture.invite({ email: EMAIL, days: 1 });
    const { grantId, onboarding } = fixture.service.findActiveInvitation({ emails: [EMAIL] })!;

    const failed = await fixture.service.compareAndSetOnboarding({
      grantId,
      expected: onboarding!,
      next: { state: "failed", error: "e".repeat(600) },
    });
    expect(failed).toMatchObject({ applied: true, onboarding: { state: "failed" } });
    expect(fixture.grants.get(EMAIL)?.onboarding?.error).toHaveLength(500);

    const retry = { state: "pending" as const };
    await expect(
      fixture.service.compareAndSetOnboarding({
        grantId: "00000000-0000-4000-8000-000000000000",
        expected: null,
        next: retry,
      }),
    ).resolves.toEqual({ applied: false, reason: "inactive" });
    vi.setSystemTime(NOW + DAY_MS);
    await expect(
      fixture.service.compareAndSetOnboarding({
        grantId,
        expected: fixture.grants.get(EMAIL)!.onboarding!,
        next: retry,
      }),
    ).resolves.toEqual({ applied: false, reason: "inactive" });
    expect(fixture.service.findActiveInvitation({ emails: [EMAIL] })).toBeUndefined();
    expect(fixture.grants.get(EMAIL)?.onboarding?.state).toBe("failed");
  });
});
