// Mattermost plugin module implements secret input behavior.
export {
  buildSecretInputSchema,
  hasConfiguredSecretInput,
  resolveSecretInputString,
} from "openclaw/plugin-sdk/secret-input";
export type { SecretInputStringResolutionMode } from "openclaw/plugin-sdk/secret-input";
