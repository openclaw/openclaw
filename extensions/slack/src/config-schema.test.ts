// Slack tests cover config schema plugin behavior.
import { describe, expect, it } from "vitest";
import { SlackConfigSchema } from "../config-api.js";

function expectSlackConfigValid(config: unknown) {
  const res = SlackConfigSchema.safeParse(config);
  expect(res.success).toBe(true);
}

function expectSlackConfigIssue(config: unknown, path: string) {
  const res = SlackConfigSchema.safeParse(config);
  expect(res.success).toBe(false);
  if (!res.success) {
    expect(res.error.issues.map((issue) => issue.path.join("."))).toContain(path);
  }
}

describe("slack config schema", () => {
  it("defaults groupPolicy to allowlist", () => {
    const res = SlackConfigSchema.safeParse({});

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.groupPolicy).toBe("allowlist");
    }
  });

  it("accepts inherited and relay companion-app transports for user postAs", () => {
    expectSlackConfigValid({
      postAs: "user",
      userToken: "test-user-token",
      appToken: "test-app-token",
      accounts: {
        work: {},
      },
    });
    expectSlackConfigValid({
      postAs: "user",
      mode: "relay",
      userToken: "test-user-token",
      relay: {
        url: "test-relay-url",
        authToken: "test-relay-auth-token",
        gatewayId: "test-gateway-id",
      },
    });
  });

  it('rejects dmPolicy="open" without allowFrom "*"', () => {
    expectSlackConfigIssue(
      {
        dmPolicy: "open",
        allowFrom: ["U123"],
      },
      "allowFrom",
    );
  });

  it("requires every relay connection field", () => {
    expectSlackConfigIssue({ mode: "relay" }, "relay.url");
    expectSlackConfigIssue(
      { mode: "relay", relay: { url: "wss://router.example.com/gateway/ws" } },
      "relay.authToken",
    );
    expectSlackConfigIssue(
      {
        mode: "relay",
        relay: {
          url: "wss://router.example.com/gateway/ws",
          authToken: "test-relay-auth-token",
        },
      },
      "relay.gatewayId",
    );
  });

  it("does not require relay transport credentials when Slack is disabled", () => {
    expectSlackConfigValid({ enabled: false, mode: "relay" });
    expectSlackConfigValid({
      enabled: false,
      mode: "relay",
      accounts: { ops: { mode: "relay" } },
    });
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
    expectSlackConfigValid({
      mode: "http",
      accounts: { ops: { enabled: false } },
    });
  });

  it("reports a missing inherited HTTP signing secret on its account only", () => {
    const result = SlackConfigSchema.safeParse({
      mode: "http",
      accounts: { ops: { botToken: "test-bot-token" } },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toEqual([
        "accounts.ops.signingSecret",
      ]);
    }
  });
});
