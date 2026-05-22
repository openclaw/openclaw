import { i as CompatMutationResult } from "./dm-access-BKMuakaH.js";
//#region src/config/channel-compat-normalization.d.ts
type LegacyStreamingAliasOptions = {
  resolvedMode: string;
  includePreviewChunk?: boolean;
  resolvedNativeTransport?: unknown;
  offModeLegacyNotice?: (pathPrefix: string) => string;
};
type NormalizeLegacyChannelAccountParams = {
  account: Record<string, unknown>;
  accountId: string;
  pathPrefix: string;
  changes: string[];
};
declare function asObjectRecord(value: unknown): Record<string, unknown> | null;
declare function hasLegacyAccountStreamingAliases(value: unknown, match: (entry: unknown) => boolean): boolean;
declare function normalizeLegacyStreamingAliases(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
} & LegacyStreamingAliasOptions): CompatMutationResult;
declare function normalizeLegacyChannelAliases(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
  normalizeDm?: boolean;
  rootDmPromoteAllowFrom?: boolean;
  normalizeAccountDm?: boolean;
  resolveStreamingOptions: (entry: Record<string, unknown>) => LegacyStreamingAliasOptions;
  normalizeAccountExtra?: (params: NormalizeLegacyChannelAccountParams) => CompatMutationResult;
}): CompatMutationResult;
declare function hasLegacyStreamingAliases(value: unknown, options?: {
  includePreviewChunk?: boolean;
  includeNativeTransport?: boolean;
}): boolean;
//#endregion
//#region src/plugins/doctor-session-route-state-owner-types.d.ts
type DoctorSessionRouteStateOwner = {
  id: string;
  label: string;
  providerIds?: readonly string[];
  runtimeIds?: readonly string[];
  cliSessionKeys?: readonly string[];
  authProfilePrefixes?: readonly string[];
};
//#endregion
export { hasLegacyAccountStreamingAliases as a, normalizeLegacyStreamingAliases as c, asObjectRecord as i, LegacyStreamingAliasOptions as n, hasLegacyStreamingAliases as o, NormalizeLegacyChannelAccountParams as r, normalizeLegacyChannelAliases as s, DoctorSessionRouteStateOwner as t };