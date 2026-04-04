export { normalizeCompatibilityConfig, legacyConfigRules } from "./src/doctor-contract.js";
export {
  collectRuntimeConfigAssignments,
  secretTargetRegistryEntries,
} from "./src/secret-contract.js";

export function hasConfiguredState(params: { env?: NodeJS.ProcessEnv }): boolean {
  return ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN", "SLACK_USER_TOKEN"].some(
    (key) => typeof params.env?.[key] === "string" && params.env[key]?.trim().length > 0,
  );
}
