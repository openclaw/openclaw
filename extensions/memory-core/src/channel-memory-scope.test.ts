import { describe, expect, it } from "vitest";
import { resolveChannelMemoryQmdCollections } from "./channel-memory-scope.js";
import { asOpenClawConfig } from "./tools.test-helpers.js";

describe("channel memory QMD collection scoping", () => {
  it("stays disabled unless explicitly enabled", () => {
    expect(
      resolveChannelMemoryQmdCollections({
        cfg: asOpenClawConfig({}),
        agentId: "main",
        sessionKey: "agent:main:slack:channel:C0AHZFCAS1K",
      }),
    ).toEqual({ enabled: false });
  });

  it("derives default Slack channel collections from the session key", () => {
    expect(
      resolveChannelMemoryQmdCollections({
        cfg: scopeConfig(),
        agentId: "main",
        sessionKey: "agent:main:slack:channel:C0AHZFCAS1K",
      }),
    ).toEqual({
      enabled: true,
      collectionNames: ["memory-global-main", "memory-private-main", "memory-slack-c0ahzfcas1k"],
    });
  });

  it("derives default Slack DM collections from the session key", () => {
    expect(
      resolveChannelMemoryQmdCollections({
        cfg: scopeConfig(),
        agentId: "main",
        sessionKey: "agent:main:slack:dm:U0B1S1N6FL5",
      }),
    ).toEqual({
      enabled: true,
      collectionNames: ["memory-global-main", "memory-private-main", "memory-dm-main-u0b1s1n6fl5"],
    });
  });

  it("requires a reason for manual scope overrides by default", () => {
    expect(
      resolveChannelMemoryQmdCollections({
        cfg: scopeConfig(),
        agentId: "main",
        sessionKey: "agent:main:slack:channel:C1",
        override: { includeScopes: ["slack_channel:C2"] },
      }),
    ).toEqual({ enabled: true, error: "memory scope override requires a reason" });
  });

  it("allows explicit Slack channel override scopes with a reason", () => {
    expect(
      resolveChannelMemoryQmdCollections({
        cfg: scopeConfig(),
        agentId: "main",
        sessionKey: "agent:main:slack:channel:C1",
        override: { includeScopes: ["slack_channel:C2"], reason: "answering linked thread" },
      }),
    ).toEqual({
      enabled: true,
      collectionNames: [
        "memory-global-main",
        "memory-private-main",
        "memory-slack-c1",
        "memory-slack-c2",
      ],
    });
  });

  it("denies manual access to another agent's private scope", () => {
    expect(
      resolveChannelMemoryQmdCollections({
        cfg: scopeConfig(),
        agentId: "main",
        sessionKey: "agent:main:slack:channel:C1",
        override: { includeScopes: ["agent_private:ceo"], reason: "debugging" },
      }),
    ).toEqual({ enabled: true, error: "memory scope override denied for agent_private:ceo" });
  });

  it("honors custom collection names and prefixes", () => {
    expect(
      resolveChannelMemoryQmdCollections({
        cfg: scopeConfig({
          collections: {
            global: "team-global",
            agentPrivatePrefix: "agent-",
            slackChannelPrefix: "chan-",
            slackDmPrefix: "dm-",
          },
        }),
        agentId: "bill",
        sessionKey: "agent:bill:slack:channel:C0OPENCLAW",
      }),
    ).toEqual({
      enabled: true,
      collectionNames: ["team-global", "agent-bill", "chan-c0openclaw"],
    });
  });
});

function scopeConfig(channelScopes: Record<string, unknown> = {}) {
  return asOpenClawConfig({
    memory: {
      backend: "qmd",
      qmd: {
        channelScopes: {
          enabled: true,
          ...channelScopes,
        },
      },
    },
  });
}
