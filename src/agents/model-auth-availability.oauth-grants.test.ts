import { describe, expect, it } from "vitest";
import { authStore, evaluate, platformRoute } from "./model-auth-availability.test-support.js";

describe("OAuth inference grants", () => {
  it("selects the API route for a token-sharing grant", () => {
    expect(
      evaluate({
        store: authStore({
          "openai:shared": {
            type: "oauth",
            provider: "openai",
            authFlow: "chatgpt-token-sharing",
            access: "shared-access",
            refresh: "shared-refresh",
            expires: Date.now() + 60_000,
          },
        }),
      }),
    ).toMatchObject({
      availability: true,
      evidence: "profile",
      selectedAuthMode: "oauth",
      selectedProfileId: "openai:shared",
      selectedRoute: platformRoute,
    });
  });

  it("does not advertise inference for an identity-only ChatGPT login", () => {
    expect(
      evaluate({
        store: authStore({
          "openai:identity": {
            type: "oauth",
            provider: "openai",
            authFlow: "chatgpt-identity",
            access: "identity-access",
            refresh: "identity-refresh",
            expires: Date.now() + 60_000,
          },
        }),
      }).availability,
    ).toBe(false);
  });
});
