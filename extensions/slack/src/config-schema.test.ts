import { describe, expect, it } from "vitest";
import { SlackConfigSchema } from "../config-api.js";

const user = { postAs: "user", userToken: "test-user-token" };
const relay = {
  url: "test-relay-url",
  authToken: "test-relay-auth-token",
  gatewayId: "test-gateway-id",
};

describe("slack config schema", () => {
  it("defaults groupPolicy to allowlist", () => {
    expect(SlackConfigSchema.parse({}).groupPolicy).toBe("allowlist");
  });

  it.each([
    ["inherited user transport", { ...user, appToken: "test-app-token", accounts: { work: {} } }],
    ["relay user transport", { ...user, mode: "relay", relay }],
    ["disabled relay", { enabled: false, mode: "relay" }],
    [
      "disabled inherited relay",
      { enabled: false, mode: "relay", accounts: { ops: { mode: "relay" } } },
    ],
    [
      "disabled inherited HTTP account",
      {
        mode: "http",
        accounts: {
          disabled: { enabled: false },
          ops: { botToken: "test-bot-token", signingSecret: "test-ops-signing-secret" },
        },
      },
    ],
    ["only disabled HTTP account", { mode: "http", accounts: { ops: { enabled: false } } }],
  ])("accepts %s", (_name, config) => {
    expect(SlackConfigSchema.safeParse(config).success).toBe(true);
  });

  it.each([
    ["allowFrom", { dmPolicy: "open", allowFrom: ["U123"] }, false],
    ["relay.url", { mode: "relay" }, false],
    ["relay.authToken", { mode: "relay", relay: { url: relay.url } }, false],
    [
      "relay.gatewayId",
      { mode: "relay", relay: { url: relay.url, authToken: relay.authToken } },
      false,
    ],
    ["signingSecret", { mode: "http" }, false],
    [
      "accounts.ops.signingSecret",
      { mode: "http", accounts: { ops: { botToken: "test-bot-token" } } },
      true,
    ],
  ] as const)("reports missing or invalid %s", (path, config, exact) => {
    const result = SlackConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toEqual(exact ? [path] : expect.arrayContaining([path]));
    }
  });
});
