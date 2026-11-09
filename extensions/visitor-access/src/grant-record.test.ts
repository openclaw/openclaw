import { describe, expect, it } from "vitest";
import { invitationMetadata, type ActiveVisitorInvitation } from "./grant-record.js";
import { visitorInviteResult } from "./invite-result.js";
import { useVisitorFixtures, visitorFixture } from "./visitors.test-support.js";

const EMAIL = "visitor@example.com";
const LONE_HIGH_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u;

function invitationTextFor(invitedByLabel: string): string {
  const metadata = invitationMetadata(undefined, {
    invitedBy: { profileId: "operator-1", label: invitedByLabel },
  });
  const grant: ActiveVisitorInvitation = {
    email: EMAIL,
    grantId: "grant-1",
    createdAt: 0,
    expiresAt: null,
    ...metadata,
  };
  return visitorInviteResult({
    renewed: false,
    target: EMAIL,
    grant,
    gatewayAccess: "Access granted.",
    signInUrl: "https://team.example.com/",
    noteSupplied: false,
  }).details.invitationText;
}

describe("visitor inviter label bounds", () => {
  useVisitorFixtures();

  it("bounds a display name on the UTF-16 boundary instead of splitting a surrogate pair", () => {
    // 199 units then an astral rune: a raw slice(0, 200) keeps the lone high surrogate.
    const text = invitationTextFor(`${"x".repeat(199)}🙂`);

    expect(text).toContain(`${"x".repeat(199)} invited you to OpenClaw.`);
    expect(text).not.toMatch(LONE_HIGH_SURROGATE);
  });

  it("keeps a whole display name that fits within the bound", () => {
    expect(invitationTextFor("Ada 🙂")).toContain("Ada 🙂 invited you to OpenClaw.");
  });

  it("records the bounded display name through the invite service without a broken pair", async () => {
    const fixture = visitorFixture({ githubLogin: "Current-Visitor" });
    const result = await fixture.service.invite(
      { email: EMAIL },
      {
        ...fixture.authority,
        invitedBy: { profileId: "operator-1", label: `${"x".repeat(199)}🙂` },
        signInUrl: "https://team.example.com/",
      },
    );

    expect(fixture.grants.get(EMAIL)?.invitedBy?.label).toBe("x".repeat(199));
    expect(result.details.invitationText).not.toMatch(LONE_HIGH_SURROGATE);
  });
});
