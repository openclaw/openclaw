import {
  buildChannelConfigSchema,
  getChatChannelMeta,
  SlackConfigSchema,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/slack";
import { type ResolvedSlackAccount } from "./accounts.js";
import { isSlackInteractiveRepliesEnabled } from "./interactive-replies.js";
import { slackSetupAdapter } from "./setup-core.js";
import { slackSetupWizard } from "./setup-surface.js";
import { isSlackPluginAccountConfigured, slackConfigAccessors, slackConfigBase } from "./shared.js";

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
    isConfigured: (account) => isSlackPluginAccountConfigured(account),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: isSlackPluginAccountConfigured(account),
      botTokenSource: account.botTokenSource,
      appTokenSource: account.appTokenSource,
    }),
    ...slackConfigAccessors,
  },
  setup: slackSetupAdapter,
};
