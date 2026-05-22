import { r as createLegacyPrivateNetworkDoctorContract } from "./ssrf-policy-BiSNj1t0.js";
import "./ssrf-runtime-BdcRu7L4.js";
//#region extensions/tlon/src/doctor-contract.ts
const contract = createLegacyPrivateNetworkDoctorContract({ channelKey: "tlon" });
const legacyConfigRules = contract.legacyConfigRules;
const normalizeCompatibilityConfig = contract.normalizeCompatibilityConfig;
//#endregion
export { normalizeCompatibilityConfig as n, legacyConfigRules as t };
