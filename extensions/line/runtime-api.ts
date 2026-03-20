// Private runtime barrel for the bundled LINE extension.
// Keep this barrel thin and aligned with the local extension surface.

export type { OpenClawConfig } from "openclaw/plugin-sdk/line-core";
export type { ChannelSetupDmPolicy, ChannelSetupWizard } from "openclaw/plugin-sdk/channel-setup";
export type { LineConfig, ResolvedLineAccount } from "openclaw/plugin-sdk/line-core";
export { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
export {
  DEFAULT_ACCOUNT_ID,
  formatDocsLink,
  LineConfigSchema,
  listLineAccountIds,
  normalizeAccountId,
  resolveDefaultLineAccountId,
  resolveExactLineGroupConfigKey,
  resolveLineAccount,
  setSetupChannelEnabled,
  splitSetupEntries,
} from "openclaw/plugin-sdk/line-core";
