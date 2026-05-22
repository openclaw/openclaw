import { i as OpenClawConfig } from "../../types.openclaw-BuKAF4PW.js";
import { Et as ProviderAuthResult } from "../../types-9OpM7mYQ.js";
import { n as readClaudeCliCredentialsForSetup } from "../../cli-auth-seam-CQN97C0O.js";
//#region extensions/anthropic/cli-migration.d.ts
type ClaudeCliCredential = NonNullable<ReturnType<typeof readClaudeCliCredentialsForSetup>>;
declare function hasClaudeCliAuth(options?: {
  allowKeychainPrompt?: boolean;
}): boolean;
declare function buildAnthropicCliMigrationResult(config: OpenClawConfig, credential?: ClaudeCliCredential | null): ProviderAuthResult;
//#endregion
export { buildAnthropicCliMigrationResult, hasClaudeCliAuth };