import { r as createLegacyPrivateNetworkDoctorContract } from "./ssrf-policy-iK0Q9rn6.js";
import "./ssrf-runtime-CJrKqHnq.js";
//#region extensions/tlon/src/doctor-contract.ts
const contract = createLegacyPrivateNetworkDoctorContract({ channelKey: "tlon" });
const legacyConfigRules = contract.legacyConfigRules;
const normalizeCompatibilityConfig = contract.normalizeCompatibilityConfig;
//#endregion
export { normalizeCompatibilityConfig as n, legacyConfigRules as t };
