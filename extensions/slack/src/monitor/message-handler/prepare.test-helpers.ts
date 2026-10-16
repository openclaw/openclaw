// Slack helper module supports prepare helpers behavior.
import path from "node:path";
import type { App } from "@slack/bolt";
import type { ChannelRuntimeSurface } from "openclaw/plugin-sdk/channel-contract";
import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { upsertSessionEntry, type SessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { useSessionStoreTempDirs } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, vi } from "vitest";
import type { ResolvedSlackAccount } from "../../accounts.js";
import { installSlackTestRuntime } from "../../test-runtime.test-support.js";
import type { SlackMessageEvent } from "../../types.js";
import type { SlackChannelConfigEntries } from "../channel-config.js";
import { createSlackMonitorContext } from "../context.js";

export function createInboundSlackTestContext(params: {
  accountId?: string;
  app?: App;
  cfg: OpenClawConfig;
  appClient?: App["client"];
  defaultRequireMention?: boolean;
  replyToMode?: "off" | "all" | "first" | "batched";
  channelsConfig?: SlackChannelConfigEntries;
  dmHistoryLimit?: number;
  groupDmEnabled?: boolean;
  groupPolicy?: "open" | "disabled" | "allowlist";
  channelRuntime?: ChannelRuntimeSurface;
}) {
  const runtime = installSlackTestRuntime({
    channel: { inbound: { buildContext: buildChannelInboundEventContext } },
  });
  return createSlackMonitorContext({
    cfg: params.cfg,
    accountId: params.accountId ?? "default",
    botToken: "token",
    app: params.app ?? ({ client: params.appClient ?? {} } as App),
    runtime: {} as RuntimeEnv,
    channelRuntime: params.channelRuntime ?? runtime.channel,
    botUserId: "B1",
    botId: "B1",
    identityHealth: { lifecycle: "ready", lastError: null },
    teamId: "T1",
    apiAppId: "A1",
    historyLimit: 0,
    dmHistoryLimit: params.dmHistoryLimit,
    sessionScope: "per-sender",
    mainKey: "main",
    dmEnabled: true,
    dmPolicy: "open",
    allowFrom: ["*"],
    allowNameMatching: false,
    groupDmEnabled: params.groupDmEnabled ?? true,
    groupDmChannels: [],
    defaultRequireMention: params.defaultRequireMention ?? true,
    channelsConfig: params.channelsConfig,
    groupPolicy: params.groupPolicy ?? "open",
    useAccessGroups: true,
    reactionMode: "off",
    reactionAllowlist: [],
    replyToMode: params.replyToMode ?? "off",
    threadHistoryScope: "thread",
    threadInheritParent: false,
    slashCommand: {
      enabled: false,
      name: "openclaw",
      sessionPrefix: "slack:slash",
      ephemeral: true,
    },
    textLimit: 4000,
    typingReaction: "",
    mediaMaxBytes: 1024,
  });
}

export function createSlackTestAccount(
  config: ResolvedSlackAccount["config"] = {},
): ResolvedSlackAccount {
  return {
    accountId: "default",
    enabled: true,
    identity: "bot",
    botTokenSource: "config",
    appTokenSource: "config",
    userTokenSource: "none",
    config,
    replyToMode: config.replyToMode,
    replyToModeByChatType: config.replyToModeByChatType,
    dm: config.dm,
  };
}

export function createSlackSessionStoreFixture(prefix: string) {
  const sessionDirs = useSessionStoreTempDirs(afterAll, prefix);

  return {
    makeTmpStorePath() {
      const dir = sessionDirs.make();
      return { dir, storePath: path.join(dir, "sessions.json") };
    },
  };
}

export function createMissingChannelInfoBotCtx(params?: {
  groupDmEnabled?: boolean;
  ownerId?: string;
}) {
  const conversationsInfo = vi
    .fn<App["client"]["conversations"]["info"]>()
    .mockRejectedValue(new Error("missing_scope"));
  const members = vi.fn().mockResolvedValue({
    members: params?.ownerId ? [params.ownerId] : [],
    response_metadata: { next_cursor: "" },
  });
  const ctx = createInboundSlackTestContext({
    cfg: {
      channels: { slack: { enabled: true, allowBots: true, replyToMode: "all" } },
    } as OpenClawConfig,
    appClient: {
      conversations: { info: conversationsInfo, members },
    } as unknown as App["client"],
    defaultRequireMention: false,
    replyToMode: "all",
    groupDmEnabled: params?.groupDmEnabled,
  });
  ctx.allowFrom = params?.ownerId ? [params.ownerId] : ctx.allowFrom;
  ctx.resolveUserName = async () => ({ name: "Alice" });
  return {
    account: createSlackTestAccount({ allowBots: true, replyToMode: "all" }),
    conversationsInfo,
    ctx,
  };
}

export function createSlackMessage(overrides: Partial<SlackMessageEvent>): SlackMessageEvent {
  return {
    type: "message",
    channel: "D123",
    channel_type: "im",
    user: "U1",
    text: "hi",
    ts: "1.000",
    ...overrides,
  };
}

export async function seedSessionEntries(
  storePath: string,
  entries: Record<string, SessionEntry>,
): Promise<void> {
  await Promise.all(
    Object.entries(entries).map(([sessionKey, entry]) =>
      upsertSessionEntry({ storePath, sessionKey, entry }),
    ),
  );
}
