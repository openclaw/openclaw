import { createScopedChannelConfigBase } from "openclaw/plugin-sdk/compat";
import {
  createScopedAccountConfigAccessors,
  formatAllowFromLowercase,
} from "openclaw/plugin-sdk/compat";
import {
  buildChannelConfigSchema,
  getChatChannelMeta,
  SlackConfigSchema,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/slack";
import { inspectSlackAccount } from "./account-inspect.js";
import {
  listSlackAccountIds,
  resolveDefaultSlackAccountId,
  resolveSlackAccount,
  type ResolvedSlackAccount,
} from "./accounts.js";
import { isSlackInteractiveRepliesEnabled } from "./interactive-replies.js";
import { createSlackSetupWizardProxy, slackSetupAdapter } from "./setup-core.js";

async function loadSlackChannelRuntime() {
  return await import("./channel.runtime.js");
}

function isSlackAccountConfigured(account: ResolvedSlackAccount): boolean {
  const mode = account.config.mode ?? "socket";
  const hasBotToken = Boolean(account.botToken?.trim());
  if (!hasBotToken) {
    return false;
  }
  if (mode === "http") {
    return Boolean(account.config.signingSecret?.trim());
  }
  return Boolean(account.appToken?.trim());
}

const slackConfigAccessors = createScopedAccountConfigAccessors({
  resolveAccount: ({ cfg, accountId }) => resolveSlackAccount({ cfg, accountId }),
  resolveAllowFrom: (account: ResolvedSlackAccount) => account.dm?.allowFrom,
  formatAllowFrom: (allowFrom) => formatAllowFromLowercase({ allowFrom }),
  resolveDefaultTo: (account: ResolvedSlackAccount) => account.config.defaultTo,
});

const slackConfigBase = createScopedChannelConfigBase({
  sectionKey: "slack",
  listAccountIds: listSlackAccountIds,
  resolveAccount: (cfg, accountId) => resolveSlackAccount({ cfg, accountId }),
  inspectAccount: (cfg, accountId) => inspectSlackAccount({ cfg, accountId }),
  defaultAccountId: resolveDefaultSlackAccountId,
  clearBaseFields: ["botToken", "appToken", "name"],
});

const slackSetupWizard = createSlackSetupWizardProxy(async () => ({
  slackSetupWizard: (await loadSlackChannelRuntime()).slackSetupWizard,
}));

export const slackSetupPlugin: ChannelPlugin<ResolvedSlackAccount> = {
  id: "slack",
  meta: {
    ...getChatChannelMeta("slack"),
    preferSessionLookupForAnnounceTarget: true,
  },
  setupWizard: slackSetupWizard,
  capabilities: {
    chatTypes: ["direct", "channel", "thread"],
    reactions: true,
    threads: true,
    media: true,
    nativeCommands: true,
  },
  agentPrompt: {
    messageToolHints: ({ cfg, accountId }) =>
      isSlackInteractiveRepliesEnabled({ cfg, accountId })
        ? [
            "- Slack interactive replies: use `[[slack_buttons: Label:value, Other:other]]` to add action buttons that route clicks back as Slack interaction system events.",
            "- Slack selects: use `[[slack_select: Placeholder | Label:value, Other:other]]` to add a static select menu that routes the chosen value back as a Slack interaction system event.",
          ]
        : [
            "- Slack interactive replies are disabled. If needed, ask to set `channels.slack.capabilities.interactiveReplies=true` (or the same under `channels.slack.accounts.<account>.capabilities`).",
          ],
  },
  streaming: {
    blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
  },
  reload: { configPrefixes: ["channels.slack"] },
  configSchema: buildChannelConfigSchema(SlackConfigSchema),
  config: {
    ...slackConfigBase,
    isConfigured: (account) => isSlackAccountConfigured(account),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: isSlackAccountConfigured(account),
      botTokenSource: account.botTokenSource,
      appTokenSource: account.appTokenSource,
    }),
    ...slackConfigAccessors,
  },
  setup: slackSetupAdapter,
};
