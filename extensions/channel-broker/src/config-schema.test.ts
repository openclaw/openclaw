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
  it("accepts nested broker capability metadata and normalizes platform overrides", () => {
    const result = safeParseChannelBrokerConfig({
      accounts: {
        acme: {
          enabled: true,
          baseUrl: "https://broker.example.test",
          platforms: ["slack"],
          capabilities: {
            slack: {
              platform: "Slack",
              delivery: { text: true, thread: true, replyTo: true },
              live: { draftPreview: true, previewFinalization: true },
              receive: { webhook: true, ackAfterDurableSend: true },
              native: { botApi: true },
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

    expect(account.capabilities.slack).toEqual({
      platform: "slack",
      delivery: { text: true, thread: true, replyTo: true },
      live: { draftPreview: true, previewFinalization: true },
      receive: { webhook: true, ackAfterDurableSend: true },
      native: { botApi: true },
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
});
