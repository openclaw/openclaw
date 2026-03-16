import {
  parseSetupEntriesAllowingWildcard,
  promptParsedAllowFromForScopedChannel,
  setChannelDmPolicyWithAllowFrom,
  setSetupChannelEnabled,
} from "../../../src/channels/plugins/setup-wizard-helpers.js";
import type { ChannelSetupDmPolicy } from "../../../src/channels/plugins/setup-wizard-types.js";
import { type ChannelSetupWizard } from "../../../src/channels/plugins/setup-wizard.js";
import { detectBinary } from "../../../src/commands/onboard-helpers.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { DEFAULT_ACCOUNT_ID } from "../../../src/routing/session-key.js";
import { formatDocsLink } from "../../../src/terminal/links.js";
import type { WizardPrompter } from "../../../src/wizard/prompts.js";
import {
  listIMessageAccountIds,
  resolveDefaultIMessageAccountId,
  resolveIMessageAccount,
} from "./accounts.js";
import { imessageSetupAdapter, parseIMessageAllowFromEntries } from "./setup-core.js";

const channel = "imessage" as const;

async function promptIMessageAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<OpenClawConfig> {
  return promptParsedAllowFromForScopedChannel({
    cfg: params.cfg,
    channel,
    accountId: params.accountId,
    defaultAccountId: resolveDefaultIMessageAccountId(params.cfg),
    prompter: params.prompter,
    noteTitle: "iMessage allowlist",
    noteLines: [
      "Allowlist iMessage DMs by handle or chat target.",
      "Examples:",
      "- +15555550123",
      "- user@example.com",
      "- chat_id:123",
      "- chat_guid:... or chat_identifier:...",
      "Multiple entries: comma-separated.",
      `Docs: ${formatDocsLink("/imessage", "imessage")}`,
    ],
    message: "iMessage allowFrom (handle or chat_id)",
    placeholder: "+15555550123, user@example.com, chat_id:123",
    parseEntries: parseIMessageAllowFromEntries,
    getExistingAllowFrom: ({ cfg, accountId }) =>
      resolveIMessageAccount({ cfg, accountId }).config.allowFrom ?? [],
  });
}

const imessageDmPolicy: ChannelSetupDmPolicy = {
  label: "iMessage",
  channel,
  policyKey: "channels.imessage.dmPolicy",
  allowFromKey: "channels.imessage.allowFrom",
  getCurrent: (cfg) => cfg.channels?.imessage?.dmPolicy ?? "pairing",
  setPolicy: (cfg, policy) =>
    setChannelDmPolicyWithAllowFrom({
      cfg,
      channel,
      dmPolicy: policy,
    }),
  promptAllowFrom: promptIMessageAllowFrom,
};

export const imessageSetupWizard: ChannelSetupWizard = {
  channel,
  status: {
    configuredLabel: "configured",
    unconfiguredLabel: "needs setup",
    configuredHint: "imsg found",
    unconfiguredHint: "imsg missing",
    configuredScore: 1,
    unconfiguredScore: 0,
    resolveConfigured: ({ cfg }) =>
      listIMessageAccountIds(cfg).some((accountId) => {
        const account = resolveIMessageAccount({ cfg, accountId });
        return Boolean(
          account.config.cliPath ||
          account.config.dbPath ||
          account.config.allowFrom ||
          account.config.service ||
          account.config.region,
        );
      }),
    resolveStatusLines: async ({ cfg, configured }) => {
      const cliPath = cfg.channels?.imessage?.cliPath ?? "imsg";
      const cliDetected = await detectBinary(cliPath);
      return [
        `iMessage: ${configured ? "configured" : "needs setup"}`,
        `imsg: ${cliDetected ? "found" : "missing"} (${cliPath})`,
      ];
    },
    resolveSelectionHint: async ({ cfg }) => {
      const cliPath = cfg.channels?.imessage?.cliPath ?? "imsg";
      return (await detectBinary(cliPath)) ? "imsg found" : "imsg missing";
    },
    resolveQuickstartScore: async ({ cfg }) => {
      const cliPath = cfg.channels?.imessage?.cliPath ?? "imsg";
      return (await detectBinary(cliPath)) ? 1 : 0;
    },
  },
  credentials: [],
  textInputs: [
    {
      inputKey: "cliPath",
      message: "imsg CLI path",
      initialValue: ({ cfg, accountId }) =>
        resolveIMessageAccount({ cfg, accountId }).config.cliPath ?? "imsg",
      currentValue: ({ cfg, accountId }) =>
        resolveIMessageAccount({ cfg, accountId }).config.cliPath ?? "imsg",
      shouldPrompt: async ({ currentValue }) => !(await detectBinary(currentValue ?? "imsg")),
      confirmCurrentValue: false,
      applyCurrentValue: true,
      helpTitle: "iMessage",
      helpLines: ["imsg CLI path required to enable iMessage."],
    },
  ],
  completionNote: {
    title: "iMessage next steps",
    lines: [
      "This is still a work in progress.",
      "Ensure OpenClaw has Full Disk Access to Messages DB.",
      "Grant Automation permission for Messages when prompted.",
      "List chats with: imsg chats --limit 20",
      `Docs: ${formatDocsLink("/imessage", "imessage")}`,
    ],
  },
  dmPolicy: imessageDmPolicy,
  disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
};

export { imessageSetupAdapter, parseIMessageAllowFromEntries };
