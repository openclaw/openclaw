/**
 * SSRF policy helpers re-exported for Browser network/navigation guards.
 */
export {
  NetworkTargetBlockedError,
  isPrivateNetworkAllowedByPolicy,
  resolvePinnedHostnameWithPolicy,
  type LookupFn,
  type NetworkTargetPolicy,
} from "../../sdk-security-runtime.js";
