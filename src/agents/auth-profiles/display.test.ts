/**
 * Tests auth profile display labels.
 * Verifies configured display names/emails are used without fabricating labels.
 */
import { describe, expect, it } from "vitest";
import {
  createAuthProfileStoreFixture,
  createOAuthRefreshCredential,
} from "./credential-fixtures.test-support.js";
import { resolveAuthProfileDisplayLabel } from "./display.js";

describe("resolveAuthProfileDisplayLabel", () => {
  it("prefers displayName over email metadata", () => {
    const label = resolveAuthProfileDisplayLabel({
      cfg: {
        auth: {
          profiles: {
            "openai:id-abc": {
              provider: "openai",
              mode: "oauth",
              displayName: "Work account",
              email: "work@example.com",
            },
          },
        },
      },
      store: createAuthProfileStoreFixture({}),
      profileId: "openai:id-abc",
    });

    expect(label).toBe("openai:id-abc (Work account)");
  });

  it("does not synthesize bogus labels when no human metadata exists", () => {
    const label = resolveAuthProfileDisplayLabel({
      store: createAuthProfileStoreFixture({
        "openai:id-abc": createOAuthRefreshCredential({ access: "token" }),
      }),
      profileId: "openai:id-abc",
    });

    expect(label).toBe("openai:id-abc");
  });
});
