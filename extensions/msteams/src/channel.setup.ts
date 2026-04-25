import type { ChannelPlugin } from "../channel-plugin-api.js";
import { MSTeamsChannelConfigSchema } from "./config-schema.js";
import { msteamsSetupAdapter } from "./setup-core.js";
import { msteamsSetupWizard } from "./setup-surface.js";

const meta = {
  id: "msteams",
  label: "Microsoft Teams",
  selectionLabel: "Microsoft Teams (Bot Framework)",
  docsPath: "/channels/msteams",
  docsLabel: "msteams",
  blurb: "Teams SDK; enterprise support.",
  aliases: ["teams"],
  order: 60,
} as const;

export const msteamsSetupPlugin: ChannelPlugin = {
  id: "msteams",
  meta: {
    ...meta,
    aliases: [...meta.aliases],
  },
  capabilities: {
    chatTypes: ["direct", "channel", "thread"],
    polls: true,
    threads: true,
    media: true,
  },
  reload: { configPrefixes: ["channels.msteams"] },
  configSchema: MSTeamsChannelConfigSchema,
  setupWizard: msteamsSetupWizard,
  setup: msteamsSetupAdapter,
};
