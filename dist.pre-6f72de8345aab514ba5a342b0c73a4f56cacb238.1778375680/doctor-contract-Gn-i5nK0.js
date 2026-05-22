import { r as createLegacyPrivateNetworkDoctorContract } from "./ssrf-policy-B0NGZjE7.js";
import "./ssrf-runtime-CNU9UpXf.js";
//#region extensions/mattermost/src/doctor-contract.ts
const contract = createLegacyPrivateNetworkDoctorContract({ channelKey: "mattermost" });
const legacyConfigRules = contract.legacyConfigRules;
const normalizeCompatibilityConfig = contract.normalizeCompatibilityConfig;
//#endregion
export { normalizeCompatibilityConfig as n, legacyConfigRules as t };
