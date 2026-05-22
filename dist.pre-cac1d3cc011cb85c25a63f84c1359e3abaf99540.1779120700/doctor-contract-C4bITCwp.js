import { r as createLegacyPrivateNetworkDoctorContract } from "./ssrf-policy-DYNSxqZe.js";
import "./ssrf-runtime-DiZYIPIC.js";
//#region extensions/tlon/src/doctor-contract.ts
const contract = createLegacyPrivateNetworkDoctorContract({ channelKey: "tlon" });
const legacyConfigRules = contract.legacyConfigRules;
const normalizeCompatibilityConfig = contract.normalizeCompatibilityConfig;
//#endregion
export { normalizeCompatibilityConfig as n, legacyConfigRules as t };
