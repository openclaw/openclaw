import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PluginApprovalRequest,
  PluginApprovalResolved,
} from "../../../src/infra/plugin-approvals.js";
import type { PluginRuntime } from "../../../src/plugins/runtime/types.js";
import { createStartAccountContext } from "../../../test/helpers/plugins/start-account-context.js";
import type { ResolvedDiscordAccount } from "./accounts.js";
import type { OpenClawConfig } from "./runtime-api.js";
let discordPlugin: typeof import("./channel.js").discordPlugin;
let setDiscordRuntime: typeof import("./runtime.js").setDiscordRuntime;

const probeDiscordMock = vi.hoisted(() => vi.fn());
const monitorDiscordProviderMock = vi.hoisted(() => vi.fn());
const auditDiscordChannelPermissionsMock = vi.hoisted(() => vi.fn());

vi.mock("./probe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./probe.js")>();
  return {
    ...actual,
    probeDiscord: probeDiscordMock,
  };
});

vi.mock("./monitor/provider.runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./monitor/provider.runtime.js")>();
  return {
    ...actual,
    monitorDiscordProvider: monitorDiscordProviderMock,
  };
});

vi.mock("./audit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./audit.js")>();
  return {
    ...actual,
    auditDiscordChannelPermissions: auditDiscordChannelPermissionsMock,
  };
});

function createCfg(): OpenClawConfig {
  return {
    channels: {
      discord: {
        enabled: true,
        token: "discord-token",
      },
    },
  } as OpenClawConfig;
}

function createPluginApprovalRequest(
  overrides?: Partial<PluginApprovalRequest["request"]>,
): PluginApprovalRequest {
  return {
    id: "plugin:approval-1",
    request: {
      title: "Sensitive plugin action",
      description: "The plugin asked to perform a sensitive action.",
      severity: "warning",
      pluginId: "plugin-test",
      toolName: "plugin.tool",
      agentId: "agent-1",
      sessionKey: "agent:agent-1:discord:channel:123456789",
      ...overrides,
    },
    createdAtMs: 1_000,
    expiresAtMs: 61_000,
  };
}

function createPluginApprovalResolved(
  request?: PluginApprovalRequest["request"],
): PluginApprovalResolved {
  return {
    id: "plugin:approval-1",
    decision: "allow-once",
    resolvedBy: "discord:123",
    ts: 2_000,
    request,
  };
}

function resolveAccount(cfg: OpenClawConfig): ResolvedDiscordAccount {
  return discordPlugin.config.resolveAccount(cfg, "default") as ResolvedDiscordAccount;
}

function startDiscordAccount(cfg: OpenClawConfig) {
  return discordPlugin.gateway!.startAccount!(
    createStartAccountContext({
      account: resolveAccount(cfg),
      cfg,
    }),
  );
}

function installDiscordRuntime(discord: Record<string, unknown>) {
  setDiscordRuntime({
    channel: {
      discord,
    },
    logging: {
      shouldLogVerbose: () => false,
    },
  } as unknown as PluginRuntime);
}

afterEach(() => {
  probeDiscordMock.mockReset();
  monitorDiscordProviderMock.mockReset();
  auditDiscordChannelPermissionsMock.mockReset();
});

beforeEach(async () => {
  vi.useRealTimers();
  installDiscordRuntime({});
});

beforeAll(async () => {
  ({ discordPlugin } = await import("./channel.js"));
  ({ setDiscordRuntime } = await import("./runtime.js"));
});

describe("discordPlugin outbound", () => {
  it("forwards mediaLocalRoots to sendMessageDiscord", async () => {
    const sendMessageDiscord = vi.fn(async () => ({ messageId: "m1" }));
    installDiscordRuntime({
      sendMessageDiscord,
    });

    const result = await discordPlugin.outbound!.sendMedia!({
      cfg: {} as OpenClawConfig,
      to: "channel:123",
      text: "hi",
      mediaUrl: "/tmp/image.png",
      mediaLocalRoots: ["/tmp/agent-root"],
      accountId: "work",
    });

    expect(sendMessageDiscord).toHaveBeenCalledWith(
      "channel:123",
      "hi",
      expect.objectContaining({
        mediaUrl: "/tmp/image.png",
        mediaLocalRoots: ["/tmp/agent-root"],
      }),
    );
    expect(result).toMatchObject({ channel: "discord", messageId: "m1" });
  });

  it("builds interactive plugin approval pending payloads for Discord forwarding", () => {
    const cfg = createCfg();
    cfg.channels!.discord!.execApprovals = {
      enabled: true,
      approvers: ["123"],
    };
    const payload = discordPlugin.execApprovals?.render?.plugin?.buildPendingPayload?.({
      cfg,
      request: createPluginApprovalRequest(),
      target: { channel: "discord", to: "user:123" },
      nowMs: 2_000,
    });

    expect(payload?.text).toContain("Plugin approval required");
    const discordData = (payload?.channelData as { discord?: { components?: unknown } } | undefined)
      ?.discord;
    expect(discordData?.components).toBeDefined();
    const componentsJson = JSON.stringify(discordData?.components ?? {});
    expect(componentsJson).toContain("Plugin Approval Required");
    expect(componentsJson).toContain("execapproval:id=plugin%3Aapproval-1;action=allow-once");
    const execApproval = (payload?.channelData as { execApproval?: { approvalId?: string } })
      ?.execApproval;
    expect(execApproval?.approvalId).toBe("plugin:approval-1");
  });

  it("neutralizes plugin approval mentions in forwarded text and components", () => {
    const cfg = createCfg();
    cfg.channels!.discord!.execApprovals = {
      enabled: true,
      approvers: ["123"],
    };
    const payload = discordPlugin.execApprovals?.render?.plugin?.buildPendingPayload?.({
      cfg,
      request: createPluginApprovalRequest({
        title: "Heads up @everyone <@123> <@&456>",
        description: "route @here and <#789>",
      }),
      target: { channel: "discord", to: "user:123" },
      nowMs: 2_000,
    });

    const text = payload?.text ?? "";
    const componentsJson = JSON.stringify(
      ((payload?.channelData as { discord?: { components?: unknown } } | undefined)?.discord
        ?.components ?? {}) as object,
    );

    expect(text).toContain("@\u200beveryone");
    expect(text).toContain("@\u200bhere");
    expect(text).toContain("<@\u200b123>");
    expect(text).toContain("<@\u200b&456>");
    expect(text).toContain("<#\u200b789>");
    expect(text).not.toContain("@everyone");
    expect(text).not.toContain("@here");
    expect(componentsJson).not.toContain("@everyone");
    expect(componentsJson).not.toContain("@here");
    expect(componentsJson).not.toContain("<@123>");
    expect(componentsJson).not.toContain("<@&456>");
    expect(componentsJson).not.toContain("<#789>");
  });

  it("falls back to non-interactive plugin approval pending payload when Discord exec approvals are disabled", () => {
    const payload = discordPlugin.execApprovals?.render?.plugin?.buildPendingPayload?.({
      cfg: createCfg(),
      request: createPluginApprovalRequest(),
      target: { channel: "discord", to: "user:123" },
      nowMs: 2_000,
    });

    expect(payload?.text).toContain("Plugin approval required");
    const channelData = payload?.channelData as
      | {
          execApproval?: { approvalId?: string; approvalSlug?: string };
          discord?: { components?: unknown };
        }
      | undefined;
    expect(channelData?.execApproval?.approvalId).toBe("plugin:approval-1");
    expect(channelData?.execApproval?.approvalSlug).toBe("plugin:a");
    expect(channelData?.discord?.components).toBeUndefined();
  });

  it("builds rich plugin approval resolved payloads when request snapshot is available", () => {
    const payload = discordPlugin.execApprovals?.render?.plugin?.buildResolvedPayload?.({
      cfg: createCfg(),
      resolved: createPluginApprovalResolved(createPluginApprovalRequest().request),
      target: { channel: "discord", to: "user:123" },
    });

    expect(payload?.text).toContain("Plugin approval allowed once");
    const discordData = (payload?.channelData as { discord?: { components?: unknown } } | undefined)
      ?.discord;
    expect(discordData?.components).toBeDefined();
    const componentsJson = JSON.stringify(discordData?.components ?? {});
    expect(componentsJson).toContain("Plugin Approval: Allowed (once)");
  });

  it("falls back to plain text plugin resolved payload when request snapshot is missing", () => {
    const payload = discordPlugin.execApprovals?.render?.plugin?.buildResolvedPayload?.({
      cfg: createCfg(),
      resolved: createPluginApprovalResolved(undefined),
      target: { channel: "discord", to: "user:123" },
    });

    expect(payload?.text).toContain("Plugin approval allowed once");
    const discordData = (payload?.channelData as { discord?: { components?: unknown } } | undefined)
      ?.discord;
    expect(discordData?.components).toBeUndefined();
  });

  it("uses direct Discord probe helpers for status probes", async () => {
    const runtimeProbeDiscord = vi.fn(async () => {
      throw new Error("runtime Discord probe should not be used");
    });
    installDiscordRuntime({
      probeDiscord: runtimeProbeDiscord,
    });
    probeDiscordMock.mockResolvedValue({
      ok: true,
      bot: { username: "Bob" },
      application: {
        intents: {
          messageContent: "limited",
          guildMembers: "disabled",
          presence: "disabled",
        },
      },
      elapsedMs: 1,
    });

    const cfg = createCfg();
    const account = resolveAccount(cfg);

    await discordPlugin.status!.probeAccount!({
      account,
      timeoutMs: 5000,
      cfg,
    });

    expect(probeDiscordMock).toHaveBeenCalledWith("discord-token", 5000, {
      includeApplication: true,
    });
    expect(runtimeProbeDiscord).not.toHaveBeenCalled();
  });

  it("uses direct Discord startup helpers before monitoring", async () => {
    const runtimeProbeDiscord = vi.fn(async () => {
      throw new Error("runtime Discord probe should not be used");
    });
    const runtimeMonitorDiscordProvider = vi.fn(async () => {
      throw new Error("runtime Discord monitor should not be used");
    });
    installDiscordRuntime({
      probeDiscord: runtimeProbeDiscord,
      monitorDiscordProvider: runtimeMonitorDiscordProvider,
    });
    probeDiscordMock.mockResolvedValue({
      ok: true,
      bot: { username: "Bob" },
      application: {
        intents: {
          messageContent: "limited",
          guildMembers: "disabled",
          presence: "disabled",
        },
      },
      elapsedMs: 1,
    });
    monitorDiscordProviderMock.mockResolvedValue(undefined);

    const cfg = createCfg();
    await startDiscordAccount(cfg);

    expect(probeDiscordMock).toHaveBeenCalledWith("discord-token", 2500, {
      includeApplication: true,
    });
    expect(monitorDiscordProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "discord-token",
        accountId: "default",
      }),
    );
    expect(runtimeProbeDiscord).not.toHaveBeenCalled();
    expect(runtimeMonitorDiscordProvider).not.toHaveBeenCalled();
  });
});

describe("discordPlugin bindings", () => {
  it("preserves user-prefixed current conversation ids for DM binds", () => {
    const result = discordPlugin.bindings?.resolveCommandConversation?.({
      accountId: "default",
      originatingTo: "user:123456789012345678",
    });

    expect(result).toEqual({
      conversationId: "user:123456789012345678",
    });
  });

  it("preserves channel-prefixed current conversation ids for channel binds", () => {
    const result = discordPlugin.bindings?.resolveCommandConversation?.({
      accountId: "default",
      originatingTo: "channel:987654321098765432",
    });

    expect(result).toEqual({
      conversationId: "channel:987654321098765432",
    });
  });

  it("preserves channel-prefixed parent ids for thread binds", () => {
    const result = discordPlugin.bindings?.resolveCommandConversation?.({
      accountId: "default",
      originatingTo: "channel:thread-42",
      threadId: "thread-42",
      threadParentId: "parent-9",
    });

    expect(result).toEqual({
      conversationId: "thread-42",
      parentConversationId: "channel:parent-9",
    });
  });
});

describe("discordPlugin security", () => {
  it("normalizes dm allowlist entries with trimmed prefixes and mentions", () => {
    const resolveDmPolicy = discordPlugin.security?.resolveDmPolicy;
    if (!resolveDmPolicy) {
      throw new Error("resolveDmPolicy unavailable");
    }

    const cfg = {
      channels: {
        discord: {
          token: "discord-token",
          dm: { policy: "allowlist", allowFrom: ["  discord:<@!123456789>  "] },
        },
      },
    } as OpenClawConfig;

    const result = resolveDmPolicy({
      cfg,
      account: discordPlugin.config.resolveAccount(cfg, "default") as ResolvedDiscordAccount,
    });
    if (!result) {
      throw new Error("discord resolveDmPolicy returned null");
    }

    expect(result.policy).toBe("allowlist");
    expect(result.allowFrom).toEqual(["  discord:<@!123456789>  "]);
    expect(result.normalizeEntry?.("  discord:<@!123456789>  ")).toBe("123456789");
    expect(result.normalizeEntry?.("  user:987654321  ")).toBe("987654321");
  });
});

describe("discordPlugin groups", () => {
  it("uses plugin-owned group policy resolvers", () => {
    const cfg = {
      channels: {
        discord: {
          token: "discord-test",
          guilds: {
            guild1: {
              requireMention: false,
              tools: { allow: ["message.guild"] },
              channels: {
                "123": {
                  requireMention: true,
                  tools: { allow: ["message.channel"] },
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      discordPlugin.groups?.resolveRequireMention?.({
        cfg,
        groupSpace: "guild1",
        groupId: "123",
      }),
    ).toBe(true);
    expect(
      discordPlugin.groups?.resolveToolPolicy?.({
        cfg,
        groupSpace: "guild1",
        groupId: "123",
      }),
    ).toEqual({ allow: ["message.channel"] });
  });
});
