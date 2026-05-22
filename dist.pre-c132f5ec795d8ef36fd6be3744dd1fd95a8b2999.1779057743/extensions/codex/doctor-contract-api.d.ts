import { i as OpenClawConfig } from "../../types.openclaw-BMMD0Ykw.js";
import { t as DoctorSessionRouteStateOwner } from "../../runtime-doctor-BMuUfx4N.js";

//#region extensions/codex/doctor-contract-api.d.ts
type LegacyConfigRule = {
  path: string[];
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
declare const sessionRouteStateOwners: DoctorSessionRouteStateOwner[];
//#endregion
export { legacyConfigRules, normalizeCompatibilityConfig, sessionRouteStateOwners };