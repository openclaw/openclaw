import { formatNormalizedAllowFromEntries } from "openclaw/plugin-sdk/allow-from";
import { createScopedChannelConfigAdapter } from "openclaw/plugin-sdk/channel-config-helpers";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import {
  listBlueBubblesAccountIds,
  type ResolvedBlueBubblesAccount,
  resolveBlueBubblesAccount,
  resolveDefaultBlueBubblesAccountId,
} from "./accounts.js";
import { BlueBubblesConfigSchema } from "./config-schema.js";
import { blueBubblesSetupAdapter } from "./setup-core.js";
import { blueBubblesSetupWizard } from "./setup-surface.js";
import { normalizeBlueBubblesHandle } from "./targets.js";

const meta = {
  id: "bluebubbles",
  label: "BlueBubbles",
  selectionLabel: "BlueBubbles (macOS app)",
  detailLabel: "BlueBubbles",
  docsPath: "/channels/bluebubbles",
  docsLabel: "bluebubbles",
  blurb: "iMessage via the BlueBubbles mac app + REST API.",
  systemImage: "bubble.left.and.text.bubble.right",
  aliases: ["bb"],
  order: 75,
  preferOver: ["imessage"],
} as const;

const bluebubblesConfigAdapter = createScopedChannelConfigAdapter<ResolvedBlueBubblesAccount>({
  sectionKey: "bluebubbles",
  listAccountIds: listBlueBubblesAccountIds,
  resolveAccount: (cfg, accountId) => resolveBlueBubblesAccount({ cfg, accountId }),
  defaultAccountId: resolveDefaultBlueBubblesAccountId,
  clearBaseFields: ["serverUrl", "password", "name", "webhookPath"],
  resolveAllowFrom: (account: ResolvedBlueBubblesAccount) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) =>
    formatNormalizedAllowFromEntries({
      allowFrom,
      normalizeEntry: (entry) => normalizeBlueBubblesHandle(entry.replace(/^bluebubbles:/i, "")),
    }),
});

export const bluebubblesSetupPlugin: ChannelPlugin<ResolvedBlueBubblesAccount> = {
  id: "bluebubbles",
  meta: {
    ...meta,
    aliases: [...meta.aliases],
    preferOver: [...meta.preferOver],
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: true,
    edit: true,
    unsend: true,
    reply: true,
    effects: true,
    groupManagement: true,
  },
  reload: { configPrefixes: ["channels.bluebubbles"] },
  configSchema: buildChannelConfigSchema(BlueBubblesConfigSchema),
  setupWizard: blueBubblesSetupWizard,
  config: {
    ...bluebubblesConfigAdapter,
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      baseUrl: account.baseUrl,
    }),
  },
  setup: blueBubblesSetupAdapter,
};
