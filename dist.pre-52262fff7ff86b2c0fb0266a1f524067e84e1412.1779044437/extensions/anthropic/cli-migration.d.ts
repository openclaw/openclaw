import { i as OpenClawConfig } from "../../types.openclaw-BMMD0Ykw.js";
import { Et as ProviderAuthResult } from "../../types-DzWIJtb62.js";
import { n as readClaudeCliCredentialsForSetup } from "../../cli-auth-seam-CJMdGsPd.js";
//#region extensions/anthropic/cli-migration.d.ts
type ClaudeCliCredential = NonNullable<ReturnType<typeof readClaudeCliCredentialsForSetup>>;
declare function hasClaudeCliAuth(options?: {
  allowKeychainPrompt?: boolean;
}): boolean;
declare function buildAnthropicCliMigrationResult(config: OpenClawConfig, credential?: ClaudeCliCredential | null): ProviderAuthResult;
//#endregion
export { buildAnthropicCliMigrationResult, hasClaudeCliAuth };