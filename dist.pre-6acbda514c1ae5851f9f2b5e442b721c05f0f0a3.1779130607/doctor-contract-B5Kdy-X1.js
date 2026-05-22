import { r as createLegacyPrivateNetworkDoctorContract } from "./ssrf-policy-BXL9fW4_.js";
import "./ssrf-runtime-Dz3vPG0b.js";
//#region extensions/tlon/src/doctor-contract.ts
const contract = createLegacyPrivateNetworkDoctorContract({ channelKey: "tlon" });
const legacyConfigRules = contract.legacyConfigRules;
const normalizeCompatibilityConfig = contract.normalizeCompatibilityConfig;
//#endregion
export { normalizeCompatibilityConfig as n, legacyConfigRules as t };
