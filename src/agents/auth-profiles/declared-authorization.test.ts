import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { AuthProfileAuthorizationError } from "./authorization-contract.js";
import { captureDeclaredAuthProfileAuthorization } from "./declared-authorization.js";

const profileId = "amazon-bedrock:aws-sdk";
const cfg = {
  auth: { profiles: { [profileId]: { provider: "amazon-bedrock", mode: "aws-sdk" } } },
  models: {
    providers: {
      "amazon-bedrock": {
        auth: "aws-sdk",
        baseUrl: "https://bedrock-runtime.us-west-2.amazonaws.com",
        models: [],
      },
    },
  },
} satisfies OpenClawConfig;

const capture = (overrides?: { cfg?: OpenClawConfig; assertCurrent?: () => void }) =>
  captureDeclaredAuthProfileAuthorization({
    profileId,
    provider: "amazon-bedrock",
    cfg: overrides?.cfg ?? cfg,
    assertCurrent: overrides?.assertCurrent ?? (() => {}),
  });

it("identifies the declared account rather than any credential material", async () => {
  const authority = capture();
  try {
    expect(authority.authorizationId).toMatch(/^[a-f0-9]{64}$/u);
    // The declaration is the account, so every capture of it observes one authorization.
    expect(capture().authorizationId).toBe(authority.authorizationId);
    expect(
      captureDeclaredAuthProfileAuthorization({
        profileId: "amazon-bedrock:second",
        provider: "amazon-bedrock",
        cfg: {
          ...cfg,
          auth: {
            profiles: {
              ...cfg.auth.profiles,
              "amazon-bedrock:second": { provider: "amazon-bedrock", mode: "aws-sdk" },
            },
          },
        },
        assertCurrent() {},
      }).authorizationId,
    ).not.toBe(authority.authorizationId);
    await authority.revalidate();
    authority.assertCurrent();
  } finally {
    authority.dispose();
  }
  expect(() => authority.assertCurrent()).toThrow(AuthProfileAuthorizationError);
});

it.each([
  ["config stops declaring the account", { cfg: { auth: cfg.auth } }],
  [
    "the caller's authority is gone",
    {
      assertCurrent: () => {
        throw new Error("Caller authority was retired");
      },
    },
  ],
] as const)("refuses the capture once %s", (_case, overrides) => {
  expect(() => capture(overrides)).toThrow(
    expect.objectContaining({ code: "MCP_AUTHORIZATION_RETIRED" }),
  );
});
