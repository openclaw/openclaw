import { i as OpenClawConfig } from "../../types.openclaw-D8bJSZjd.js";
import { Et as ProviderAuthResult } from "../../types-wNLvWYuA.js";
import { n as readClaudeCliCredentialsForSetup } from "../../cli-auth-seam-CHAJZZlW.js";
//#region extensions/anthropic/cli-migration.d.ts
type ClaudeCliCredential = NonNullable<ReturnType<typeof readClaudeCliCredentialsForSetup>>;
declare function hasClaudeCliAuth(options?: {
  allowKeychainPrompt?: boolean;
}): boolean;
declare function buildAnthropicCliMigrationResult(config: OpenClawConfig, credential?: ClaudeCliCredential | null): ProviderAuthResult;
//#endregion
export { buildAnthropicCliMigrationResult, hasClaudeCliAuth };