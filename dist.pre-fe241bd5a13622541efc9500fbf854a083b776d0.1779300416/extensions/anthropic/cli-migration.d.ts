import { i as OpenClawConfig } from "../../types.openclaw-Cy0U3Gwh.js";
import { At as ProviderAuthResult } from "../../types-Dw7_sm4q.js";
import { n as readClaudeCliCredentialsForSetup } from "../../cli-auth-seam-Bdb1E71d.js";
//#region extensions/anthropic/cli-migration.d.ts
type ClaudeCliCredential = NonNullable<ReturnType<typeof readClaudeCliCredentialsForSetup>>;
declare function hasClaudeCliAuth(options?: {
  allowKeychainPrompt?: boolean;
}): boolean;
declare function buildAnthropicCliMigrationResult(config: OpenClawConfig, credential?: ClaudeCliCredential | null): ProviderAuthResult;
//#endregion
export { buildAnthropicCliMigrationResult, hasClaudeCliAuth };