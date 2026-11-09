import { describe, expect, it } from "vitest";
import { useVisitorFixtures, visitorFixture } from "./visitors.test-support.js";

const EMAIL = "visitor@example.com";
const LONE_HIGH_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u;

describe("visitor inviter label bounds", () => {
  useVisitorFixtures();

  it("bounds a display name on the UTF-16 boundary instead of splitting a surrogate pair", async () => {
    // 199 units then an astral rune: a raw slice(0, 200) keeps the lone high surrogate.
    const fixture = visitorFixture();
    const result = await fixture.service.invite(
      { email: EMAIL },
      {
        ...fixture.authority,
        invitedBy: { profileId: "operator-1", label: `${"x".repeat(199)}🙂` },
        signInUrl: "https://team.example.com/",
      },
    );

    expect(fixture.grants.get(EMAIL)?.invitedBy?.label).toBe("x".repeat(199));
    expect(result.details.invitationText).toContain(`${"x".repeat(199)} invited you to OpenClaw.`);
    expect(result.details.invitationText).not.toMatch(LONE_HIGH_SURROGATE);
  });

  it("keeps a whole display name that fits within the bound", async () => {
    const fixture = visitorFixture();
    const result = await fixture.service.invite(
      { email: EMAIL },
      {
        ...fixture.authority,
        invitedBy: { profileId: "operator-1", label: "Ada 🙂" },
        signInUrl: "https://team.example.com/",
      },
    );

    expect(result.details.invitationText).toContain("Ada 🙂 invited you to OpenClaw.");
  });
});
