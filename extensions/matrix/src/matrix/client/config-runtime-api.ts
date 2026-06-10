// Matrix API module exposes the plugin public contract.
export {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeOptionalAccountId,
} from "openclaw/plugin-sdk/account-id";
export {
  isPrivateNetworkOptInEnabled,
  networkTargetPolicyFromDangerouslyAllowPrivateNetwork,
} from "openclaw/plugin-sdk/security-runtime";
