export {
  collectRuntimeConfigAssignments,
  secretTargetRegistryEntries,
} from "./src/secret-contract.js";

export function hasConfiguredState(params: { env?: NodeJS.ProcessEnv }): boolean {
  return (
    typeof params.env?.IRC_HOST === "string" &&
    params.env.IRC_HOST.trim().length > 0 &&
    typeof params.env?.IRC_NICK === "string" &&
    params.env.IRC_NICK.trim().length > 0
  );
}
