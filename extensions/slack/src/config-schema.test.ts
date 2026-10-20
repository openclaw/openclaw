import { describe, expect, it } from "vitest";
import { SlackConfigSchema } from "../config-api.js";

function expectSlackConfigValid(config: unknown) {
  const res = SlackConfigSchema.safeParse(config);
  expect(res.success).toBe(true);
}

function expectSlackConfigIssue(config: unknown, path: string, exact = false) {
  const res = SlackConfigSchema.safeParse(config);
  expect(res.success).toBe(false);
  if (!res.success) {
    const paths = res.error.issues.map((issue) => issue.path.join("."));
    if (exact) {
      expect(paths).toEqual([path]);
    } else {
      expect(paths).toContain(path);
    }
  }
}

const relay = {
  url: "test-relay-url",
  authToken: "test-relay-auth-token",
  gatewayId: "test-gateway-id",
};

describe("slack config schema", () => {
  it("defaults groupPolicy to allowlist", () => {
    expect(SlackConfigSchema.parse({}).groupPolicy).toBe("allowlist");
  });

  it("accepts inherited and relay companion-app transports for user postAs", () => {
    expectSlackConfigValid({
      postAs: "user",
      userToken: "test-user-token",
      appToken: "test-app-token",
      accounts: { work: {} },
    });
    expectSlackConfigValid({
      postAs: "user",
      mode: "relay",
      userToken: "test-user-token",
      relay,
    });
  });

  it('rejects dmPolicy="open" without allowFrom "*"', () => {
    expectSlackConfigIssue({ dmPolicy: "open", allowFrom: ["U123"] }, "allowFrom");
  });

  it("requires every relay connection field", () => {
    expectSlackConfigIssue({ mode: "relay" }, "relay.url");
    expectSlackConfigIssue({ mode: "relay", relay: { url: relay.url } }, "relay.authToken");
    expectSlackConfigIssue(
      { mode: "relay", relay: { url: relay.url, authToken: relay.authToken } },
      "relay.gatewayId",
    );
  });

  it("does not require relay transport credentials when Slack is disabled", () => {
    expectSlackConfigValid({ enabled: false, mode: "relay" });
    expectSlackConfigValid({ enabled: false, mode: "relay", accounts: { ops: { mode: "relay" } } });
  });

  it("rejects HTTP mode without signing secret", () => {
    expectSlackConfigIssue({ mode: "http" }, "signingSecret");
  });

  it("skips disabled accounts inheriting HTTP mode", () => {
    expectSlackConfigValid({
      mode: "http",
      accounts: {
        disabled: { enabled: false },
        ops: {
          botToken: "test-bot-token",
          signingSecret: "test-ops-signing-secret",
        },
      },
    });
    expectSlackConfigValid({ mode: "http", accounts: { ops: { enabled: false } } });
  });

  it("reports a missing inherited HTTP signing secret on its account only", () => {
    expectSlackConfigIssue(
      { mode: "http", accounts: { ops: { botToken: "test-bot-token" } } },
      "accounts.ops.signingSecret",
      true,
    );
  });
});
