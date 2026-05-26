import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
//#region extensions/memory-wiki/src/config-compat.d.ts
type LegacyConfigRule = {
  path: Array<string | number>;
  message: string;
  match: (value: unknown) => boolean;
};
declare const legacyConfigRules: LegacyConfigRule[];
declare function normalizeCompatibilityConfig({
  cfg
}: {
  cfg: OpenClawConfig;
}): {
  config: OpenClawConfig;
  changes: string[];
};
//#endregion
export { normalizeCompatibilityConfig as n, legacyConfigRules as t };