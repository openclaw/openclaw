import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { asNonArrayRecord, uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { buildLiveQaApprovalForwardingConfig } from "../shared/live-approval-config.js";
import { requireLiveQaEnv } from "../shared/live-credential-env.js";
import {
  type SlackQaRuntimeEnv,
  type SlackQaConfigOverrides,
  slackQaCredentialPayloadSchema,
  type SlackQaWebClient as WebClient,
} from "./slack-live.contracts.js";

function validateSlackQaRuntimeEnv(runtimeEnv: SlackQaRuntimeEnv, label: string) {
  if (!/^[A-Z][A-Z0-9]+$/.test(runtimeEnv.channelId.trim())) {
    throw new Error(`${label} channelId must be a Slack id like C123 or U123.`);
  }
  return runtimeEnv;
}

export function resolveSlackQaRuntimeEnv(env: NodeJS.ProcessEnv = process.env): SlackQaRuntimeEnv {
  const runtimeEnv = {
    channelId: requireLiveQaEnv(env, "OPENCLAW_QA_SLACK_CHANNEL_ID"),
    driverBotToken: requireLiveQaEnv(env, "OPENCLAW_QA_SLACK_DRIVER_BOT_TOKEN"),
    sutBotToken: requireLiveQaEnv(env, "OPENCLAW_QA_SLACK_SUT_BOT_TOKEN"),
    sutAppToken: requireLiveQaEnv(env, "OPENCLAW_QA_SLACK_SUT_APP_TOKEN"),
  };
  return validateSlackQaRuntimeEnv(runtimeEnv, "OPENCLAW_QA_SLACK");
}

export function parseSlackQaCredentialPayload(payload: unknown): SlackQaRuntimeEnv {
  return validateSlackQaRuntimeEnv(
    slackQaCredentialPayloadSchema.parse(payload),
    "Slack credential payload",
  );
}

type SlackQaPostMessageAttempt = {
  failureCode?: string;
  formattingDisabled: boolean;
  nativeDataBlockCount: number;
  status: "failed" | "sent";
  text: string;
};

export function countSlackNativeDataBlocks(value: unknown) {
  if (!Array.isArray(value)) {
    return 0;
  }
  return value.filter((block) => {
    const type = asNonArrayRecord(block).type;
    return type === "data_table" || type === "data_visualization";
  }).length;
}

function readSlackApiFailureCode(error: unknown) {
  const record = asNonArrayRecord(error);
  const data = asNonArrayRecord(record.data);
  const code = data.error ?? record.error;
  return typeof code === "string" && /^[a-z0-9_]{1,64}$/u.test(code) ? code : undefined;
}

export function instrumentSlackPostMessage(client: WebClient) {
  const originalPostMessage = client.chat.postMessage;
  const attempts: SlackQaPostMessageAttempt[] = [];
  client.chat.postMessage = (async (payload) => {
    const payloadRecord = payload as { blocks?: unknown; mrkdwn?: boolean; text?: unknown };
    const attempt = {
      formattingDisabled: payloadRecord.mrkdwn === false,
      nativeDataBlockCount: countSlackNativeDataBlocks(payloadRecord.blocks),
      text: typeof payloadRecord.text === "string" ? payloadRecord.text : "",
    };
    try {
      const response = await originalPostMessage.call(client.chat, payload);
      attempts.push({ ...attempt, status: "sent" });
      return response;
    } catch (error) {
      const failureCode = readSlackApiFailureCode(error);
      attempts.push({
        ...attempt,
        ...(failureCode ? { failureCode } : {}),
        status: "failed",
      });
      throw error;
    }
  }) as typeof client.chat.postMessage;
  return {
    attempts,
    restore: () => {
      client.chat.postMessage = originalPostMessage;
    },
  };
}

export function buildSlackQaConfig(
  baseCfg: OpenClawConfig,
  params: {
    channelId: string;
    driverBotUserId: string;
    overrides?: SlackQaConfigOverrides;
    primaryModel?: string;
    sutAccountId: string;
    sutAppToken: string;
    sutBotToken: string;
  },
): OpenClawConfig {
  const codexApprovalConfig = params.overrides?.codexApproval === true;
  const progressOverrides = params.overrides?.progress;
  const primaryModel = params.primaryModel;
  const pluginAllow = uniqueStrings([
    ...(baseCfg.plugins?.allow ?? []),
    "slack",
    ...(codexApprovalConfig ? ["codex"] : []),
  ]);
  const approvalOverrides = params.overrides?.approvals;
  const codexEntry = baseCfg.plugins?.entries?.codex;
  const codexEntryConfig = asNonArrayRecord(codexEntry?.config);
  const codexAppServerConfig = asNonArrayRecord(codexEntryConfig.appServer);
  const approvalForwardingConfig = buildLiveQaApprovalForwardingConfig(baseCfg, approvalOverrides);
  let qaAgentDefaults = baseCfg.agents?.defaults;
  if (codexApprovalConfig && primaryModel) {
    qaAgentDefaults = {
      ...qaAgentDefaults,
      models: {
        ...qaAgentDefaults?.models,
        [primaryModel]: {
          ...qaAgentDefaults?.models?.[primaryModel],
          agentRuntime: { id: "codex" },
        },
      },
    };
  }
  if (progressOverrides) {
    qaAgentDefaults = { ...qaAgentDefaults };
    if (progressOverrides.verboseDefault) {
      qaAgentDefaults.verboseDefault = progressOverrides.verboseDefault;
    }
  }
  const qaAgentEntries = { ...baseCfg.agents?.entries };
  if (progressOverrides && qaAgentEntries.qa) {
    // Slack draft edits cannot preserve custom authorship. Remove the
    // synthetic QA identity so progress scenarios reach the draft path.
    qaAgentEntries.qa = { ...qaAgentEntries.qa };
    delete qaAgentEntries.qa.identity;
  }
  const execApprovalsConfig = approvalOverrides
    ? {
        enabled: true,
        approvers: [params.driverBotUserId],
        target: approvalOverrides.target ?? ("channel" as const),
      }
    : undefined;
  const tools = { ...baseCfg.tools };
  if (params.overrides?.messageTool) {
    if (tools.allow?.length) {
      tools.allow = uniqueStrings([...tools.allow, "message"]);
    } else {
      tools.alsoAllow = uniqueStrings([...(tools.alsoAllow ?? []), "message"]);
    }
  }
  if (codexApprovalConfig) {
    tools.exec = { ...tools.exec, mode: "ask" };
  }
  return {
    ...baseCfg,
    ...approvalForwardingConfig,
    ...(codexApprovalConfig || params.overrides?.messageTool ? { tools } : {}),
    plugins: {
      ...baseCfg.plugins,
      allow: pluginAllow,
      entries: {
        ...baseCfg.plugins?.entries,
        slack: { enabled: true },
        ...(codexApprovalConfig
          ? {
              codex: {
                ...codexEntry,
                enabled: true,
                config: {
                  ...codexEntryConfig,
                  appServer: {
                    ...codexAppServerConfig,
                    mode: "guardian" as const,
                  },
                },
              },
            }
          : {}),
      },
    },
    ...(codexApprovalConfig || progressOverrides
      ? {
          agents: {
            ...baseCfg.agents,
            ...(qaAgentDefaults ? { defaults: qaAgentDefaults } : {}),
            ...(baseCfg.agents?.entries ? { entries: qaAgentEntries } : {}),
          },
        }
      : {}),
    messages: {
      ...baseCfg.messages,
      groupChat: {
        ...baseCfg.messages?.groupChat,
        visibleReplies: "automatic",
      },
    },
    channels: {
      ...baseCfg.channels,
      slack: {
        enabled: true,
        defaultAccount: params.sutAccountId,
        accounts: {
          [params.sutAccountId]: {
            enabled: true,
            mode: "socket",
            botToken: params.sutBotToken,
            appToken: params.sutAppToken,
            allowFrom: params.overrides?.allowFrom ?? [params.driverBotUserId],
            groupPolicy: "allowlist",
            allowBots: true,
            ...(params.overrides?.groupDmEnabled
              ? { dm: { enabled: true, groupEnabled: true } }
              : {}),
            replyToMode: params.overrides?.replyToMode ?? "off",
            ...(params.overrides?.streamingMode
              ? { streaming: { mode: params.overrides.streamingMode } }
              : progressOverrides
                ? {
                    streaming: {
                      mode: "progress" as const,
                      // These scenarios assert the portable draft compositor and
                      // chat.update identity. Native task streams have their own
                      // transport proof and do not expose that draft contract.
                      nativeTransport: false,
                      progress: {
                        // The per-run command marker is the tool-line correlation
                        // key; the product default intentionally hides raw commands.
                        commandText: "raw" as const,
                        label: false,
                        maxLines: 4,
                        ...(progressOverrides.style ? { style: progressOverrides.style } : {}),
                        toolProgress: progressOverrides.toolProgress,
                        ...(progressOverrides.commentary === undefined
                          ? {}
                          : { commentary: progressOverrides.commentary }),
                      },
                    },
                  }
                : {}),
            ...(execApprovalsConfig ? { execApprovals: execApprovalsConfig } : {}),
            channels: {
              [params.channelId]: {
                enabled: params.overrides?.channelEnabled ?? true,
                requireMention: true,
                allowBots: true,
                users: params.overrides?.users ?? [params.driverBotUserId],
              },
            },
          },
        },
      },
    },
  };
}
