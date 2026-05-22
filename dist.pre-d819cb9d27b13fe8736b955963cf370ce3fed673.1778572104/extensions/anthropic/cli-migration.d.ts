import { i as OpenClawConfig } from "../../types.openclaw-BlE9q7jU.js";
import { Tt as ProviderAuthResult } from "../../types-DzNNj7u7.js";
import { n as readClaudeCliCredentialsForSetup } from "../../cli-auth-seam-CyyFK5D7.js";
//#region extensions/anthropic/cli-migration.d.ts
type ClaudeCliCredential = NonNullable<ReturnType<typeof readClaudeCliCredentialsForSetup>>;
declare function hasClaudeCliAuth(options?: {
  allowKeychainPrompt?: boolean;
}): boolean;
declare function buildAnthropicCliMigrationResult(config: OpenClawConfig, credential?: ClaudeCliCredential | null): ProviderAuthResult;
//#endregion
export { buildAnthropicCliMigrationResult, hasClaudeCliAuth };