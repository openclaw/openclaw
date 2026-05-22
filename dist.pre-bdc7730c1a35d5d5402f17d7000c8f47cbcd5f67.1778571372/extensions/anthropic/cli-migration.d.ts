import { i as OpenClawConfig } from "../../types.openclaw-BdZr8Ncl.js";
import { Tt as ProviderAuthResult } from "../../types-D1CySu2x.js";
import { n as readClaudeCliCredentialsForSetup } from "../../cli-auth-seam-D0mHM52X.js";
//#region extensions/anthropic/cli-migration.d.ts
type ClaudeCliCredential = NonNullable<ReturnType<typeof readClaudeCliCredentialsForSetup>>;
declare function hasClaudeCliAuth(options?: {
  allowKeychainPrompt?: boolean;
}): boolean;
declare function buildAnthropicCliMigrationResult(config: OpenClawConfig, credential?: ClaudeCliCredential | null): ProviderAuthResult;
//#endregion
export { buildAnthropicCliMigrationResult, hasClaudeCliAuth };