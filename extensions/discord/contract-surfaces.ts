export { normalizeCompatibilityConfig, legacyConfigRules } from "./src/doctor-contract.js";
export {
  collectRuntimeConfigAssignments,
  secretTargetRegistryEntries,
} from "./src/secret-config-contract.js";
export {
  unsupportedSecretRefSurfacePatterns,
  collectUnsupportedSecretRefConfigCandidates,
} from "./src/security-contract.js";
export { deriveLegacySessionChatType } from "./src/session-contract.js";

export function hasConfiguredState(params: { env?: NodeJS.ProcessEnv }): boolean {
  return (
    typeof params.env?.DISCORD_BOT_TOKEN === "string" &&
    params.env.DISCORD_BOT_TOKEN.trim().length > 0
  );
}
