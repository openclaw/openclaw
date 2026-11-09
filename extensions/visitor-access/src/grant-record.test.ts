import { describe, expect, it } from "vitest";
import { useVisitorFixtures, visitorFixture } from "./visitors.test-support.js";

const EMAIL = "visitor@example.com";

describe("visitor inviter label bounds", () => {
  useVisitorFixtures();

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
