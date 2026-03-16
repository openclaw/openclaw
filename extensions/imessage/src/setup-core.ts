import {
  parseSetupEntriesAllowingWildcard,
  promptParsedAllowFromForScopedChannel,
  setChannelDmPolicyWithAllowFrom,
  setSetupChannelEnabled,
} from "../../../src/channels/plugins/setup-flow-helpers.js";
import type { ChannelSetupDmPolicy } from "../../../src/channels/plugins/setup-flow-types.js";
import {
  applyAccountNameToChannelSection,
  migrateBaseNameToDefaultAccount,
} from "../../../src/channels/plugins/setup-helpers.js";
import { type ChannelSetupWizard } from "../../../src/channels/plugins/setup-wizard.js";
import type { ChannelSetupAdapter } from "../../../src/channels/plugins/types.adapters.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../../src/routing/session-key.js";
import { formatDocsLink } from "../../../src/terminal/links.js";
import type { WizardPrompter } from "../../../src/wizard/prompts.js";
import {
  listIMessageAccountIds,
  resolveDefaultIMessageAccountId,
  resolveIMessageAccount,
} from "./accounts.js";
import { normalizeIMessageHandle } from "./targets.js";

const channel = "imessage" as const;

export function parseIMessageAllowFromEntries(raw: string): { entries: string[]; error?: string } {
  return parseSetupEntriesAllowingWildcard(raw, (entry) => {
    const lower = entry.toLowerCase();
    if (lower.startsWith("chat_id:")) {
      const id = entry.slice("chat_id:".length).trim();
      if (!/^\d+$/.test(id)) {
        return { error: `Invalid chat_id: ${entry}` };
      }
      return { value: entry };
    }
    if (lower.startsWith("chat_guid:")) {
      if (!entry.slice("chat_guid:".length).trim()) {
        return { error: "Invalid chat_guid entry" };
      }
      return { value: entry };
    }
    if (lower.startsWith("chat_identifier:")) {
      if (!entry.slice("chat_identifier:".length).trim()) {
        return { error: "Invalid chat_identifier entry" };
      }
      return { value: entry };
    }
    if (!normalizeIMessageHandle(entry)) {
      return { error: `Invalid handle: ${entry}` };
    }
    return { value: entry };
  });
}

function buildIMessageSetupPatch(input: {
  cliPath?: string;
  dbPath?: string;
  service?: "imessage" | "sms" | "auto";
  region?: string;
}) {
  return {
    ...(input.cliPath ? { cliPath: input.cliPath } : {}),
    ...(input.dbPath ? { dbPath: input.dbPath } : {}),
    ...(input.service ? { service: input.service } : {}),
    ...(input.region ? { region: input.region } : {}),
  };
}

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

export const imessageSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
  applyAccountName: ({ cfg, accountId, name }) =>
    applyAccountNameToChannelSection({
      cfg,
      channelKey: channel,
      accountId,
      name,
    }),
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const namedConfig = applyAccountNameToChannelSection({
      cfg,
      channelKey: channel,
      accountId,
      name: input.name,
    });
    const next =
      accountId !== DEFAULT_ACCOUNT_ID
        ? migrateBaseNameToDefaultAccount({
            cfg: namedConfig,
            channelKey: channel,
          })
        : namedConfig;
    if (accountId === DEFAULT_ACCOUNT_ID) {
      return {
        ...next,
        channels: {
          ...next.channels,
          imessage: {
            ...next.channels?.imessage,
            enabled: true,
            ...buildIMessageSetupPatch(input),
          },
        },
      };
    }
    return {
      ...next,
      channels: {
        ...next.channels,
        imessage: {
          ...next.channels?.imessage,
          enabled: true,
          accounts: {
            ...next.channels?.imessage?.accounts,
            [accountId]: {
              ...next.channels?.imessage?.accounts?.[accountId],
              enabled: true,
              ...buildIMessageSetupPatch(input),
            },
          },
        },
      },
    };
  },
};

export function createIMessageSetupWizardProxy(
  loadWizard: () => Promise<{ imessageSetupWizard: ChannelSetupWizard }>,
) {
  const imessageDmPolicy: ChannelSetupDmPolicy = {
    label: "iMessage",
    channel,
    policyKey: "channels.imessage.dmPolicy",
    allowFromKey: "channels.imessage.allowFrom",
    getCurrent: (cfg: OpenClawConfig) => cfg.channels?.imessage?.dmPolicy ?? "pairing",
    setPolicy: (cfg: OpenClawConfig, policy) =>
      setChannelDmPolicyWithAllowFrom({
        cfg,
        channel,
        dmPolicy: policy,
      }),
    promptAllowFrom: promptIMessageAllowFrom,
  };

  return {
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
      resolveStatusLines: async (params) =>
        (await loadWizard()).imessageSetupWizard.status.resolveStatusLines?.(params) ?? [],
      resolveSelectionHint: async (params) =>
        await (await loadWizard()).imessageSetupWizard.status.resolveSelectionHint?.(params),
      resolveQuickstartScore: async (params) =>
        await (await loadWizard()).imessageSetupWizard.status.resolveQuickstartScore?.(params),
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
        shouldPrompt: async (params) => {
          const input = (await loadWizard()).imessageSetupWizard.textInputs?.find(
            (entry) => entry.inputKey === "cliPath",
          );
          return (await input?.shouldPrompt?.(params)) ?? false;
        },
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
    disable: (cfg: OpenClawConfig) => setSetupChannelEnabled(cfg, channel, false),
  } satisfies ChannelSetupWizard;
}
