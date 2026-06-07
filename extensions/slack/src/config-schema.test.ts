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

  it("accepts historyLimit overrides per account", () => {
    const res = SlackConfigSchema.safeParse({
      historyLimit: 7,
      accounts: { ops: { historyLimit: 2 } },
    });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.historyLimit).toBe(7);
      expect(res.data.accounts?.ops?.historyLimit).toBe(2);
    }
  });

  it("accepts unfurl controls at root and account level", () => {
    const res = SlackConfigSchema.safeParse({
      unfurlLinks: false,
      unfurlMedia: false,
      accounts: {
        ops: {
          unfurlLinks: true,
          unfurlMedia: false,
        },
      },
    });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.unfurlLinks).toBe(false);
      expect(res.data.unfurlMedia).toBe(false);
      expect(res.data.accounts?.ops?.unfurlLinks).toBe(true);
      expect(res.data.accounts?.ops?.unfurlMedia).toBe(false);
    }
  });

  it("rejects invalid unfurl control types", () => {
    expectSlackConfigIssue({ unfurlLinks: "false" }, "unfurlLinks");
    expectSlackConfigIssue(
      { accounts: { ops: { unfurlMedia: "false" } } },
      "accounts.ops.unfurlMedia",
    );
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

  it('accepts legacy dm.policy="open" with top-level allowFrom alias', () => {
    expectSlackConfigValid({
      dm: { policy: "open", allowFrom: ["U123"] },
      allowFrom: ["*"],
    });
  });

  it("accepts user token config fields", () => {
    expectSlackConfigValid({
      botToken: "xoxb-any",
      appToken: "xapp-any",
      userToken: "xoxp-any",
      userTokenReadOnly: false,
    });
  });

  it("accepts Socket Mode ping/pong transport tuning", () => {
    expectSlackConfigValid({
      mode: "socket",
      socketMode: {
        clientPingTimeout: 15_000,
        serverPingTimeout: 45_000,
        pingPongLoggingEnabled: true,
      },
      accounts: {
        ops: {
          socketMode: {
            clientPingTimeout: 20_000,
          },
        },
      },
    });
  });

  it("rejects invalid Socket Mode ping/pong transport tuning", () => {
    expectSlackConfigIssue(
      {
        socketMode: {
          clientPingTimeout: 0,
        },
      },
      "socketMode.clientPingTimeout",
    );
  });

  it("accepts trusted-upstream mode with defaults", () => {
    const res = SlackConfigSchema.safeParse({
      mode: "trusted-upstream",
      botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
    });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.mode).toBe("trusted-upstream");
      expect(res.data.trustedUpstream).toEqual({
        requireHeader: {
          name: "X-OpenClaw-Trusted-Upstream-Verified",
          value: "true",
        },
        maxEventAge: 300,
      });
    }
  });

  it("accepts trusted-upstream overrides", () => {
    const res = SlackConfigSchema.safeParse({
      mode: "trusted-upstream",
      botToken: "xoxb-any",
      slackApiUrl: "http://slack-proxy.internal:8080/slack/api/",
      trustedUpstream: {
        requireHeader: {
          name: "X-Edge-Verified",
          value: "yes",
        },
        maxEventAge: 0,
      },
    });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.slackApiUrl).toBe("http://slack-proxy.internal:8080/slack/api/");
      expect(res.data.trustedUpstream?.requireHeader).toEqual({
        name: "X-Edge-Verified",
        value: "yes",
      });
      expect(res.data.trustedUpstream?.maxEventAge).toBe(0);
    }
  });

  it("rejects trusted-upstream mode without a bot token", () => {
    expectSlackConfigIssue({ mode: "trusted-upstream" }, "botToken");
  });

  it("accepts account trusted-upstream mode when base bot token is set", () => {
    expectSlackConfigValid({
      botToken: "xoxb-any",
      accounts: {
        ops: {
          mode: "trusted-upstream",
        },
      },
    });
  });

  it("accepts account-level user token config", () => {
    expectSlackConfigValid({
      accounts: {
        work: {
          botToken: "xoxb-any",
          appToken: "xapp-any",
          userToken: "xoxp-any",
          userTokenReadOnly: true,
        },
      },
    });
  });

  it("rejects invalid userTokenReadOnly types", () => {
    expectSlackConfigIssue(
      {
        botToken: "xoxb-any",
        appToken: "xapp-any",
        userToken: "xoxp-any",
        userTokenReadOnly: "no",
      },
      "userTokenReadOnly",
    );
  });

  it("rejects invalid userToken types", () => {
    expectSlackConfigIssue(
      {
        botToken: "xoxb-any",
        appToken: "xapp-any",
        userToken: 123,
      },
      "userToken",
    );
  });

  it("accepts HTTP mode when signing secret is configured", () => {
    expectSlackConfigValid({
      mode: "http",
      signingSecret: "secret",
    });
  });

  it("accepts HTTP mode when signing secret is configured as SecretRef", () => {
    expectSlackConfigValid({
      mode: "http",
      signingSecret: { source: "env", provider: "default", id: "SLACK_SIGNING_SECRET" },
    });
  });

  it("rejects HTTP mode without signing secret", () => {
    expectSlackConfigIssue({ mode: "http" }, "signingSecret");
  });

  it("accepts account HTTP mode when base signing secret is set", () => {
    expectSlackConfigValid({
      signingSecret: "secret",
      accounts: {
        ops: {
          mode: "http",
        },
      },
    });
  });

  it("accepts account HTTP mode when account signing secret is set as SecretRef", () => {
    expectSlackConfigValid({
      accounts: {
        ops: {
          mode: "http",
          signingSecret: {
            source: "env",
            provider: "default",
            id: "SLACK_OPS_SIGNING_SECRET",
          },
        },
      },
    });
  });

  it("rejects account HTTP mode without signing secret", () => {
    expectSlackConfigIssue(
      {
        accounts: {
          ops: {
            mode: "http",
          },
        },
      },
      "accounts.ops.signingSecret",
    );
  });
});
