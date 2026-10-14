import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { waitForLiveQaChannelAccount } from "../shared/live-channel-status.js";

type TelegramGatewayClient = {
  call: (method: string, params?: unknown, options?: { timeoutMs?: number }) => Promise<unknown>;
};

const TELEGRAM_QA_DEFAULT_READY_TIMEOUT_MS = 45_000;

export function buildTelegramQaConfig(params: {
  apiRoot?: string;
  additionalTesterUserIds?: string[];
  forumGroupId?: string;
  groupId: string;
  sutAccountId: string;
  sutToken: string;
  testerUserId: string;
}): OpenClawConfig {
  const testerUserIds = [params.testerUserId, ...(params.additionalTesterUserIds ?? [])];
  return {
    agents: {
      defaults: {
        models: {
          "openai/gpt-5.6-luna": {
            agentRuntime: { id: "openclaw" },
          },
        },
        skipBootstrap: true,
      },
    },
    plugins: {
      allow: ["telegram"],
      entries: {
        telegram: { enabled: true },
      },
    },
    messages: {
      groupChat: {
        visibleReplies: "automatic",
      },
    },
    channels: {
      telegram: {
        enabled: true,
        defaultAccount: params.sutAccountId,
        accounts: {
          [params.sutAccountId]: {
            enabled: true,
            botToken: params.sutToken,
            ...(params.apiRoot ? { apiRoot: params.apiRoot } : {}),
            dmPolicy: "allowlist",
            allowFrom: testerUserIds,
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
  await waitForLiveQaChannelAccount({
    gateway,
    channel: "telegram",
    accountId,
    timeoutMs: options?.timeoutMs ?? resolveTelegramQaReadyTimeoutMs(options?.env),
    pollMs: options?.pollMs ?? 500,
    isReady: (status) =>
      Boolean(status.running && status.connected === true && status.restartPending !== true),
    describeTimeout: (lastStatus, lastProbeError) => {
      const details = lastStatus
        ? `; last status: ${JSON.stringify(lastStatus)}`
        : lastProbeError
          ? `; last check error: ${lastProbeError}`
          : "";
      return `telegram account "${accountId}" did not become ready${details}`;
    },
  });
}
