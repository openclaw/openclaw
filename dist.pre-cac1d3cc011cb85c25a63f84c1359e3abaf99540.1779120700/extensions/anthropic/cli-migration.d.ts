import { i as OpenClawConfig } from "../../types.openclaw-C58U02FA.js";
import { At as ProviderAuthResult } from "../../types-UTp4ves_.js";
import { n as readClaudeCliCredentialsForSetup } from "../../cli-auth-seam-Dw24rMTD.js";
//#region extensions/anthropic/cli-migration.d.ts
type ClaudeCliCredential = NonNullable<ReturnType<typeof readClaudeCliCredentialsForSetup>>;
declare function hasClaudeCliAuth(options?: {
  allowKeychainPrompt?: boolean;
}): boolean;
declare function buildAnthropicCliMigrationResult(config: OpenClawConfig, credential?: ClaudeCliCredential | null): ProviderAuthResult;
//#endregion
export { buildAnthropicCliMigrationResult, hasClaudeCliAuth };