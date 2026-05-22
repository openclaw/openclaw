import { r as createLegacyPrivateNetworkDoctorContract } from "./ssrf-policy-CIwd6x-p.js";
import "./ssrf-runtime-Db7Y0wil.js";
//#region extensions/tlon/src/doctor-contract.ts
const contract = createLegacyPrivateNetworkDoctorContract({ channelKey: "tlon" });
const legacyConfigRules = contract.legacyConfigRules;
const normalizeCompatibilityConfig = contract.normalizeCompatibilityConfig;
//#endregion
export { normalizeCompatibilityConfig as n, legacyConfigRules as t };
