import { r as createLegacyPrivateNetworkDoctorContract } from "./ssrf-policy-2deKtDuk.js";
import "./ssrf-runtime-uB3Az6qX.js";
//#region extensions/tlon/src/doctor-contract.ts
const contract = createLegacyPrivateNetworkDoctorContract({ channelKey: "tlon" });
const legacyConfigRules = contract.legacyConfigRules;
const normalizeCompatibilityConfig = contract.normalizeCompatibilityConfig;
//#endregion
export { normalizeCompatibilityConfig as n, legacyConfigRules as t };
