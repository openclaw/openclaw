// Private runtime barrel for the bundled LINE extension.
// Keep this barrel thin and aligned with the local extension surface.

export * from "../../src/plugin-sdk/line.js";
export {
  DEFAULT_ACCOUNT_ID,
  formatDocsLink,
  resolveExactLineGroupConfigKey,
  setSetupChannelEnabled,
  splitSetupEntries,
  type ChannelSetupDmPolicy,
  type ChannelSetupWizard,
} from "../../src/plugin-sdk/line-core.js";
