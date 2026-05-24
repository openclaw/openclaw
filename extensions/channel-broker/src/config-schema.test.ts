import { describe, expect, it } from "vitest";
import { resolveChannelBrokerAccount } from "./accounts.js";
import { channelBrokerPluginConfigSchema } from "./config-schema.js";

function safeParseChannelBrokerConfig(value: unknown) {
  return channelBrokerPluginConfigSchema.runtime.safeParse(value);
}

describe("channel-broker config schema", () => {
  it("accepts nested broker capability metadata and normalizes known platform aliases", () => {
    const result = safeParseChannelBrokerConfig({
      accounts: {
        acme: {
          enabled: true,
          baseUrl: "https://broker.example.test",
          platforms: ["teams", "googlechat", "qq"],
          capabilities: {
            teams: {
              delivery: { text: true, thread: true, replyTo: true },
              live: { draftPreview: true, previewFinalization: true },
              receive: { webhook: true, ackAfterDurableSend: true },
              native: { appApi: true, workspaceHosted: true },
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
            whatsapp: {
              delivery: { text: true, media: true },
              constraints: { businessApi: true, cloudApi: true, providerHosted: true },
              badges: ["business-api", "provider-hosted"],
              native: { cloudApi: true },
            },
          },
        },
      },
    });

    expect(result.success).toBe(true);
    const account = resolveChannelBrokerAccount({
      cfg: { channels: { "channel-broker": result.data } },
      accountId: "acme",
    });

    expect(account.platforms).toEqual(["microsoft-teams", "google-chat", "qqbot"]);
    expect(account.capabilities["microsoft-teams"]).toEqual({
      platform: "microsoft-teams",
      delivery: { text: true, thread: true, replyTo: true },
      live: { draftPreview: true, previewFinalization: true },
      receive: { webhook: true, ackAfterDurableSend: true },
      native: { appApi: true, workspaceHosted: true },
    });
    expect(account.capabilities["google-chat"]?.delivery).toEqual({
      text: true,
      thread: true,
    });
    expect(account.capabilities.qqbot?.native).toEqual({ botApi: true });
    expect(account.capabilities.whatsapp?.constraints).toEqual({
      businessApi: true,
      cloudApi: true,
      providerHosted: true,
    });
    expect(account.capabilities.whatsapp?.badges).toEqual(["business-api", "provider-hosted"]);
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
    expect(result.success ? [] : result.issues.map((issue) => issue.path.join("."))).toContain(
      "accounts.acme.capabilities.matrix",
    );
  });

  it("rejects unknown constrained-provider metadata unless the broker contract models it", () => {
    const result = safeParseChannelBrokerConfig({
      accounts: {
        acme: {
          baseUrl: "https://broker.example.test",
          capabilities: {
            signal: {
              constraints: {
                selfHosted: true,
                unsupportedConstraint: true,
              },
            },
          },
        },
      },
    });

    expect(result.success).toBe(false);
    expect(result.success ? [] : result.issues.map((issue) => issue.path.join("."))).toContain(
      "accounts.acme.capabilities.signal.constraints",
    );
  });
});
