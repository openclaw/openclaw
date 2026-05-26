import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
//#region src/config/dangerous-name-matching.d.ts
type DangerousNameMatchingConfig = {
  dangerouslyAllowNameMatching?: boolean;
};
type ProviderDangerousNameMatchingScope = {
  prefix: string;
  account: Record<string, unknown>;
  dangerousNameMatchingEnabled: boolean;
  dangerousFlagPath: string;
};
type DangerousNameMatchingResolverInput = {
  providerConfig?: DangerousNameMatchingConfig | null | undefined;
  accountConfig?: DangerousNameMatchingConfig | null | undefined;
};
declare function isDangerousNameMatchingEnabled(config: DangerousNameMatchingConfig | null | undefined): boolean;
declare function resolveDangerousNameMatchingEnabled(input: DangerousNameMatchingResolverInput): boolean;
declare function collectProviderDangerousNameMatchingScopes(cfg: OpenClawConfig, provider: string): ProviderDangerousNameMatchingScope[];
//#endregion
export { isDangerousNameMatchingEnabled as n, resolveDangerousNameMatchingEnabled as r, collectProviderDangerousNameMatchingScopes as t };