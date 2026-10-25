// Slack helper module supports prepare helpers behavior.
import path from "node:path";
import type { App } from "@slack/bolt";
import type { ChannelRuntimeSurface } from "openclaw/plugin-sdk/channel-contract";
import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { useSessionStoreTempDirs } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll } from "vitest";
import type { ResolvedSlackAccount } from "../../accounts.js";
import { installSlackTestRuntime } from "../../test-runtime.test-support.js";
import type { SlackChannelConfigEntries } from "../channel-config.js";
import { createMonitorTestContext } from "../monitor-context.test-support.js";

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
  return createMonitorTestContext({
    cfg: params.cfg,
    accountId: params.accountId ?? "default",
    botToken: "token",
    app: params.app ?? ({ client: params.appClient ?? {} } as App),
    channelRuntime: params.channelRuntime ?? runtime.channel,
    botUserId: "B1",
    botId: "B1",
    teamId: "T1",
    apiAppId: "A1",
    dmHistoryLimit: params.dmHistoryLimit ?? 0,
    allowFrom: ["*"],
    groupDmEnabled: params.groupDmEnabled ?? true,
    defaultRequireMention: params.defaultRequireMention ?? true,
    channelsConfig: params.channelsConfig,
    groupPolicy: params.groupPolicy ?? "open",
    replyToMode: params.replyToMode ?? "off",
    slashCommand: {
      enabled: false,
      name: "openclaw",
      sessionPrefix: "slack:slash",
      ephemeral: true,
    },
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
