export { normalizeCompatibilityConfig, legacyConfigRules } from "./src/doctor-contract.js";
export {
  collectRuntimeConfigAssignments,
  secretTargetRegistryEntries,
} from "./src/secret-contract.js";
export {
  TELEGRAM_COMMAND_NAME_PATTERN,
  normalizeTelegramCommandDescription,
  normalizeTelegramCommandName,
  resolveTelegramCustomCommands,
} from "./src/command-config.js";
export { singleAccountKeysToMove } from "./src/setup-contract.js";

export function hasConfiguredState(params: { env?: NodeJS.ProcessEnv }): boolean {
  return (
    typeof params.env?.TELEGRAM_BOT_TOKEN === "string" &&
    params.env.TELEGRAM_BOT_TOKEN.trim().length > 0
  );
}
