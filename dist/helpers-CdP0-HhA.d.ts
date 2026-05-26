import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { N as ChannelSecurityDmPolicy } from "./types.core-BkmTlRzr.js";
//#region src/channels/plugins/helpers.d.ts
declare function formatPairingApproveHint(channelId: string): string;
declare function parseOptionalDelimitedEntries(value?: string): string[] | undefined;
declare function buildAccountScopedDmSecurityPolicy(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  accountId?: string | null;
  fallbackAccountId?: string | null;
  policy?: string | null;
  allowFrom?: Array<string | number> | null;
  defaultPolicy?: string;
  allowFromPathSuffix?: string;
  policyPathSuffix?: string;
  approveChannelId?: string;
  approveHint?: string;
  normalizeEntry?: (raw: string) => string;
  inheritSharedDefaultsFromDefaultAccount?: boolean;
}): ChannelSecurityDmPolicy;
//#endregion
export { formatPairingApproveHint as n, parseOptionalDelimitedEntries as r, buildAccountScopedDmSecurityPolicy as t };