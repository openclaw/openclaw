import { describe, expect, it } from "vitest";
import { useVisitorFixtures, visitorFixture, visitorGrant } from "./visitors.test-support.js";

const allocation = {
  id: "teams.users_allowed",
  deleted_date: "",
  allocation: { type: "max_count", value: 75 },
};
const users = () =>
  Array.from({ length: 110 }, (_, index) => ({
    seat_uid: `seat-${index}`,
    access_seat: index < 74,
    gateway_seat: index === 0 || index === 105,
    last_successful_login: "2026-11-01T12:00:00Z",
  }));
function readable(fixture: ReturnType<typeof visitorFixture>) {
  Object.assign(fixture.cloudflare, {
    entitlementStatus: 200,
    usersStatus: 200,
    failedUsersPage: 0,
    entitlements: [allocation],
    accountUsers: users(),
  });
}

describe("Visitor account capacity", () => {
  useVisitorFixtures();

  it("warns about a full shared account below the visitor cap without blocking renewals", async () => {
    const grants = Array.from({ length: 60 }, (_, index) =>
      visitorGrant(`guest-${index}@example.test`),
    );
    const fixture = visitorFixture({
      config: { maxVisitors: 70 },
      grants,
      emails: grants.map((grant) => grant.email),
    });
    readable(fixture);
    // A seat used by both products and a repeated seat identity each count once.
    fixture.cloudflare.accountUsers.push({
      seat_uid: "seat-0",
      access_seat: false,
      gateway_seat: true,
    });
    const listed = await fixture.list();
    expect(listed.details).toMatchObject({
      counts: { recorded: 60, inPolicy: 60 },
      accountSeats: { status: "full", capacity: 75, occupied: 75, remaining: 0, diagnostics: [] },
    });
    expect(listed.text).toMatch(/75.*75.*0 remaining/);
    const fresh = await fixture.invite({ email: "new@example.test" });
    expect(fresh.details).toMatchObject({
      outcome: "invited",
      accountSeats: { status: "full", remaining: 0 },
    });
    expect(fresh.text).toMatch(/new login identit.*cannot obtain a seat/i);
    const renewed = await fixture.invite({ email: grants[0]!.email });
    expect(renewed.details).toMatchObject({ outcome: "renewed", grantId: grants[0]!.grantId });
    expect(fixture.grants.size).toBe(61);
    expect(fixture.targets()).toHaveLength(61);
    expect(fresh.details.invitationText).not.toContain("Cloudflare");
    const snapshot = JSON.stringify(listed.details);
    expect(snapshot).not.toContain("seat-0");
    for (const [url, request] of fixture.fetcher.mock.calls) {
      const path = new URL(url instanceof Request ? url.url : url).pathname;
      if (!path.includes("/access/apps/")) {
        expect(request?.method).toBe("GET");
      }
    }
    fixture.cloudflare.accountUsers = [];
    expect((await fixture.list()).details).toMatchObject({
      accountSeats: { status: "available", occupied: 0, remaining: 75 },
    });
  });

  it.each([
    "users403",
    "entitlements403",
    "secondPage503",
    "missingFlag",
    "missingSeatId",
    "missingAllocation",
    "deletedAllocation",
    "duplicateAllocation",
  ] as const)(
    "reports unknown rather than invented capacity for %s and recovers on retry",
    async (failure) => {
      const fixture = visitorFixture();
      readable(fixture);
      if (failure === "users403") {
        fixture.cloudflare.usersStatus = 403;
      }
      if (failure === "entitlements403") {
        fixture.cloudflare.entitlementStatus = 403;
      }
      if (failure === "secondPage503") {
        fixture.cloudflare.failedUsersPage = 2;
      }
      if (failure === "missingFlag") {
        fixture.cloudflare.accountUsers[0] = { seat_uid: "seat-0", access_seat: true };
      }
      if (failure === "missingSeatId") {
        fixture.cloudflare.accountUsers[0] = { access_seat: true, gateway_seat: false };
      }
      if (failure === "missingAllocation") {
        fixture.cloudflare.entitlements = [];
      }
      if (failure === "deletedAllocation") {
        fixture.cloudflare.entitlements = [{ ...allocation, deleted_date: "2026-11-01" }];
      }
      if (failure === "duplicateAllocation") {
        fixture.cloudflare.entitlements.push(allocation);
      }
      const result = await fixture.invite({ email: "visitor@example.test" });
      const occupancyUnknown = [
        "users403",
        "secondPage503",
        "missingFlag",
        "missingSeatId",
      ].includes(failure);
      expect(result.details).toMatchObject({
        outcome: "invited",
        accountSeats: {
          status: "unknown",
          capacity: occupancyUnknown ? 75 : null,
          occupied: occupancyUnknown ? null : 75,
          remaining: null,
          diagnostics: [expect.any(String)],
        },
      });
      expect(result.text).toMatch(/seat.*unknown/i);
      if (failure.endsWith("403")) {
        expect(result.text).toContain("403");
      }
      expect(fixture.grants.has("visitor@example.test")).toBe(true);
      readable(fixture);
      expect((await fixture.list()).details).toMatchObject({
        accountSeats: { status: "full", capacity: 75, occupied: 75 },
      });
    },
  );

  it("does not downgrade lost manager authority into an optional seat-read failure", async () => {
    const fixture = visitorFixture();
    readable(fixture);
    const fetch = fixture.fetcher.getMockImplementation()!;
    fixture.fetcher.mockImplementation(async (input, init) => {
      const response = await fetch(input, init);
      const path = new URL(input instanceof Request ? input.url : input).pathname;
      if (path.endsWith("/access/users")) {
        fixture.revokeAuthority();
      }
      return response;
    });
    await expect(fixture.list()).rejects.toThrow("authority is no longer current");
    expect(fixture.mutations()).toEqual([]);
  });
});
