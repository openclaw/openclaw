import { r as createLegacyPrivateNetworkDoctorContract } from "./ssrf-policy-DGCN0k7_.js";
import "./ssrf-runtime-B3HHI4NS.js";
//#region extensions/mattermost/src/doctor-contract.ts
const contract = createLegacyPrivateNetworkDoctorContract({ channelKey: "mattermost" });
const legacyConfigRules = contract.legacyConfigRules;
const normalizeCompatibilityConfig = contract.normalizeCompatibilityConfig;
//#endregion
export { normalizeCompatibilityConfig as n, legacyConfigRules as t };
