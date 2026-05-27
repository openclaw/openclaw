import { describe, expect, it } from "vitest";
import { resolveChannelBrokerAccount } from "./accounts.js";
import { channelBrokerPluginConfigSchema } from "./config-schema.js";
import type { ChannelBrokerConfig } from "./types.js";

function safeParseChannelBrokerConfig(value: unknown) {
  const runtimeSchema = channelBrokerPluginConfigSchema.runtime;
  if (!runtimeSchema) {
    throw new Error("channel-broker runtime config schema is required");
  }
  return runtimeSchema.safeParse(value);
}

type ChannelBrokerConfigParseResult = ReturnType<typeof safeParseChannelBrokerConfig>;

function expectParsedChannelBrokerConfig(
  result: ChannelBrokerConfigParseResult,
): ChannelBrokerConfig {
  if (!result.success) {
    throw new Error(`expected channel-broker config to parse: ${JSON.stringify(result.issues)}`);
  }
  return result.data as ChannelBrokerConfig;
}

function issuePaths(result: ChannelBrokerConfigParseResult): string[] {
  return result.success ? [] : result.issues.map((issue) => issue.path?.join(".") ?? "");
}

describe("channel-broker config schema", () => {
  it("accepts nested broker capability metadata and normalizes known platform aliases", () => {
    const result = safeParseChannelBrokerConfig({
      accounts: {
        acme: {
          enabled: true,
          baseUrl: "https://broker.example.test",
          platforms: ["teams", "googlechat", "qq", "constructor"],
          capabilities: {
            teams: {
              delivery: { text: true, replyTo: true },
              live: { draftPreview: true, previewFinalization: true },
              receive: { webhook: true, ackAfterDurableSend: true },
              native: { appApi: true, workspaceHosted: true },
            },
            "microsoft-teams": {
              delivery: { thread: true },
              live: { progressUpdates: true },
              native: { tenantScoped: true },
            },
            googlechat: {
              platform: "google-chat",
              delivery: { text: true, thread: true },
              receive: { webhook: true },
              native: { appApi: true },
            },
            qq: {
              delivery: { text: true },
              native: { botApi: true },
            },
            constructor: {
              delivery: { payload: true },
            },
          },
        },
      },
    });

    const parsedConfig = expectParsedChannelBrokerConfig(result);
    const account = resolveChannelBrokerAccount({
      cfg: { channels: { "channel-broker": parsedConfig } },
      accountId: "acme",
    });

    expect(account.platforms).toEqual(["microsoft-teams", "google-chat", "qqbot", "constructor"]);
    expect(account.capabilities["microsoft-teams"]).toEqual({
      platform: "microsoft-teams",
      delivery: { text: true, thread: true, replyTo: true },
      live: { draftPreview: true, previewFinalization: true, progressUpdates: true },
      receive: { webhook: true, ackAfterDurableSend: true },
      native: { appApi: true, tenantScoped: true, workspaceHosted: true },
    });
    expect(account.capabilities["google-chat"]?.delivery).toEqual({
      text: true,
      thread: true,
    });
    expect(account.capabilities.qqbot?.native).toEqual({ botApi: true });
    expect(account.capabilities["constructor"]).toEqual({
      platform: "constructor",
      delivery: { payload: true },
    });
  });

  it("rejects legacy flat capability fields so provider metadata matches the SDK shape", () => {
    const result = safeParseChannelBrokerConfig({
      accounts: {
        acme: {
          baseUrl: "https://broker.example.test",
          capabilities: {
            matrix: {
              inbound: true,
              threads: true,
            },
          },
        },
      },
    });

    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain("accounts.acme.capabilities.matrix");
  });

  it("does not resolve secrets for disabled broker accounts", () => {
    const account = resolveChannelBrokerAccount({
      cfg: {
        channels: {
          "channel-broker": {
            accounts: {
              acme: {
                enabled: false,
                baseUrl: "https://broker.example.test",
                outboundToken: { source: "env", provider: "default", id: "BROKER_TOKEN" },
                signingSecret: {
                  source: "env",
                  provider: "default",
                  id: "BROKER_SIGNING_SECRET",
                },
              },
            },
          },
        },
      },
      accountId: "acme",
    });

    expect(account.enabled).toBe(false);
    expect(account.outboundToken).toBeNull();
    expect(account.signingSecret).toBeNull();
  });

  it("falls back to a listed provider when the configured default is stale", () => {
    const account = resolveChannelBrokerAccount({
      cfg: {
        channels: {
          "channel-broker": {
            defaultProviderId: "missing",
            accounts: {
              acme: {
                baseUrl: "https://broker.example.test",
                platforms: ["slack"],
              },
            },
          },
        },
      },
    });

    expect(account.providerId).toBe("acme");
    expect(account.baseUrl).toBe("https://broker.example.test");
  });
});
