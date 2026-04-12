export { collectProviderDangerousNameMatchingScopes } from "../../../src/config/dangerous-name-matching.js";
export {
  asObjectRecord,
  hasLegacyAccountStreamingAliases,
  hasLegacyStreamingAliases,
  normalizeLegacyDmAliases,
  normalizeLegacyStreamingAliases,
} from "../../../src/config/channel-compat-normalization.js";
export {
  detectPluginInstallPathIssue,
  formatPluginInstallPathIssue,
} from "../../../src/infra/plugin-install-path-warnings.js";
export { removePluginFromConfig } from "../../../src/plugins/uninstall.js";
