import { i as OpenClawConfig } from "../../types.openclaw-BYfkTL_f.js";
import { At as ProviderAuthResult } from "../../types-CkHYPqDj.js";
import { n as readClaudeCliCredentialsForSetup } from "../../cli-auth-seam-DUgpLQH9.js";
//#region extensions/anthropic/cli-migration.d.ts
type ClaudeCliCredential = NonNullable<ReturnType<typeof readClaudeCliCredentialsForSetup>>;
declare function hasClaudeCliAuth(options?: {
  allowKeychainPrompt?: boolean;
}): boolean;
declare function buildAnthropicCliMigrationResult(config: OpenClawConfig, credential?: ClaudeCliCredential | null): ProviderAuthResult;
//#endregion
export { buildAnthropicCliMigrationResult, hasClaudeCliAuth };