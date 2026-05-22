import { r as createLegacyPrivateNetworkDoctorContract } from "./ssrf-policy-C4UtfBWx.js";
import "./ssrf-runtime-R6sAwobj.js";
//#region extensions/tlon/src/doctor-contract.ts
const contract = createLegacyPrivateNetworkDoctorContract({ channelKey: "tlon" });
const legacyConfigRules = contract.legacyConfigRules;
const normalizeCompatibilityConfig = contract.normalizeCompatibilityConfig;
//#endregion
export { normalizeCompatibilityConfig as n, legacyConfigRules as t };
