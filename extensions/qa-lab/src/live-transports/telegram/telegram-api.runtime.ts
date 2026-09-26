import { setTimeout as sleep } from "node:timers/promises";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { readLiveQaChannelAccounts } from "../shared/live-channel-status.js";

type TelegramChannelStatus = Pick<
  ChannelAccountSnapshot,
  | "accountId"
  | "connected"
  | "lastConnectedAt"
  | "lastDisconnect"
  | "lastError"
  | "restartPending"
  | "running"
>;

type TelegramGatewayClient = {
  call: (method: string, params?: unknown, options?: { timeoutMs?: number }) => Promise<unknown>;
};

const TELEGRAM_QA_DEFAULT_READY_TIMEOUT_MS = 45_000;

export function buildTelegramQaConfig(
  baseCfg: OpenClawConfig,
  params: {
    apiRoot?: string;
    directMessageOnly?: boolean;
    enableDirectMessages?: boolean;
    additionalTesterUserIds?: string[];
    forumGroupId?: string;
    groupId: string;
    sutAccountId: string;
    sutToken: string;
    testerUserId: string;
  },
): OpenClawConfig {
  const testerUserIds = [params.testerUserId, ...(params.additionalTesterUserIds ?? [])];
  return {
    ...baseCfg,
    agents: {
      ...baseCfg.agents,
      defaults: {
        ...baseCfg.agents?.defaults,
        models: {
          ...baseCfg.agents?.defaults?.models,
          "openai/gpt-5.6-luna": {
            ...baseCfg.agents?.defaults?.models?.["openai/gpt-5.6-luna"],
            agentRuntime: { id: "openclaw" },
          },
        },
        skipBootstrap: true,
      },
    },
    plugins: {
      ...baseCfg.plugins,
      allow: uniqueStrings([...(baseCfg.plugins?.allow ?? []), "telegram"]),
      entries: {
        ...baseCfg.plugins?.entries,
        telegram: { enabled: true },
      },
    },
    messages: {
      ...baseCfg.messages,
      groupChat: {
        ...baseCfg.messages?.groupChat,
        visibleReplies: "automatic",
      },
    },
    channels: {
      ...baseCfg.channels,
      telegram: {
        enabled: true,
        defaultAccount: params.sutAccountId,
        accounts: {
          [params.sutAccountId]: {
            enabled: true,
            botToken: params.sutToken,
            ...(params.apiRoot ? { apiRoot: params.apiRoot } : {}),
            ...(params.directMessageOnly || params.enableDirectMessages
              ? { dmPolicy: "allowlist", allowFrom: testerUserIds }
              : { dmPolicy: "disabled" }),
            groups: Object.fromEntries(
              uniqueStrings([
                params.groupId,
                ...(params.forumGroupId ? [params.forumGroupId] : []),
              ]).map((groupId) => [
                groupId,
                {
                  groupPolicy: "allowlist",
                  allowFrom: testerUserIds,
                  // Concurrent leases share this group and QA sender. Only this
                  // bot's mentions or reply chain may trigger an agent turn.
                  requireMention: true,
                },
              ]),
            ),
          },
        },
      },
    },
  };
}

function resolveTelegramQaReadyTimeoutMs(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.OPENCLAW_QA_TRANSPORT_READY_TIMEOUT_MS;
  return raw
    ? (parseStrictPositiveInteger(raw) ?? TELEGRAM_QA_DEFAULT_READY_TIMEOUT_MS)
    : TELEGRAM_QA_DEFAULT_READY_TIMEOUT_MS;
}

export async function waitForTelegramChannelRunning(
  gateway: TelegramGatewayClient,
  accountId: string,
  options?: { env?: NodeJS.ProcessEnv; pollMs?: number; timeoutMs?: number },
) {
  const startedAt = Date.now();
  const timeoutMs = options?.timeoutMs ?? resolveTelegramQaReadyTimeoutMs(options?.env);
  const pollMs = options?.pollMs ?? 500;
  let lastProbeError: string | undefined;
  let lastStatus: TelegramChannelStatus | undefined;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const accounts = await readLiveQaChannelAccounts(gateway, "telegram");
      const match = accounts.find((entry) => entry.accountId === accountId);
      lastProbeError = undefined;
      lastStatus = match;
      if (match?.running && match.connected === true && match.restartPending !== true) {
        return;
      }
    } catch (error) {
      lastProbeError = formatErrorMessage(error);
    }
    await sleep(pollMs);
  }
  const details = lastStatus
    ? `; last status: ${JSON.stringify(lastStatus)}`
    : lastProbeError
      ? `; last probe error: ${lastProbeError}`
      : "";
  throw new Error(`telegram account "${accountId}" did not become ready${details}`);
}
