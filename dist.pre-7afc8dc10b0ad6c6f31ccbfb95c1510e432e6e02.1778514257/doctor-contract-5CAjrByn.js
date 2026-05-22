import { r as createLegacyPrivateNetworkDoctorContract } from "./ssrf-policy-5_1lUt6y.js";
import "./ssrf-runtime-CkUGpkoc.js";
//#region extensions/tlon/src/doctor-contract.ts
const contract = createLegacyPrivateNetworkDoctorContract({ channelKey: "tlon" });
const legacyConfigRules = contract.legacyConfigRules;
const normalizeCompatibilityConfig = contract.normalizeCompatibilityConfig;
//#endregion
export { normalizeCompatibilityConfig as n, legacyConfigRules as t };
