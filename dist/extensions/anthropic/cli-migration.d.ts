import { i as OpenClawConfig } from "../../types.openclaw-BLF4DJTX.js";
import { At as ProviderAuthResult } from "../../types-Vx7Jq4_-2.js";
import { n as readClaudeCliCredentialsForSetup } from "../../cli-auth-seam-C4YfOvuK.js";
//#region extensions/anthropic/cli-migration.d.ts
type ClaudeCliCredential = NonNullable<ReturnType<typeof readClaudeCliCredentialsForSetup>>;
declare function hasClaudeCliAuth(options?: {
  allowKeychainPrompt?: boolean;
}): boolean;
declare function buildAnthropicCliMigrationResult(config: OpenClawConfig, credential?: ClaudeCliCredential | null): ProviderAuthResult;
//#endregion
export { buildAnthropicCliMigrationResult, hasClaudeCliAuth };