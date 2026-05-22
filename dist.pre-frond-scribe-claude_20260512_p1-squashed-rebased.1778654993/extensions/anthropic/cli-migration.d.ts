import { i as OpenClawConfig } from "../../types.openclaw-BdSNxnBz.js";
import { Tt as ProviderAuthResult } from "../../types-ItMBrbf4.js";
import { n as readClaudeCliCredentialsForSetup } from "../../cli-auth-seam-C14dE8Ww.js";
//#region extensions/anthropic/cli-migration.d.ts
type ClaudeCliCredential = NonNullable<ReturnType<typeof readClaudeCliCredentialsForSetup>>;
declare function hasClaudeCliAuth(options?: {
  allowKeychainPrompt?: boolean;
}): boolean;
declare function buildAnthropicCliMigrationResult(config: OpenClawConfig, credential?: ClaudeCliCredential | null): ProviderAuthResult;
//#endregion
export { buildAnthropicCliMigrationResult, hasClaudeCliAuth };