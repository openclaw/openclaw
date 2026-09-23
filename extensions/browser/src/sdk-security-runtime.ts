/**
 * Browser-local SDK security bridge.
 */
export {
  ensurePortAvailable,
  extractErrorCode,
  formatErrorMessage,
  hasProxyEnvConfigured,
  isPrivateNetworkAllowedByPolicy,
  matchesHostnameAllowlist,
  normalizeHostname,
  pathScope,
  resolveExistingPathsWithinRoot,
  resolvePinnedHostnameWithPolicy,
  sanitizeUntrustedFileName,
  resolveStrictExistingPathsWithinRoot,
  root,
  SsrFBlockedError,
  writeExternalFileWithinRoot,
  wrapExternalContent,
} from "openclaw/plugin-sdk/security-runtime";
export type { LookupFn, SsrFPolicy } from "openclaw/plugin-sdk/security-runtime";
