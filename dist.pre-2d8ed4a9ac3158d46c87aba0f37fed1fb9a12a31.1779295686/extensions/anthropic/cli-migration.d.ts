import { i as OpenClawConfig } from "../../types.openclaw-DPnlcagS.js";
import { At as ProviderAuthResult } from "../../types-D0OCNFd4.js";
import { n as readClaudeCliCredentialsForSetup } from "../../cli-auth-seam-CBnfwUcz.js";
//#region extensions/anthropic/cli-migration.d.ts
type ClaudeCliCredential = NonNullable<ReturnType<typeof readClaudeCliCredentialsForSetup>>;
declare function hasClaudeCliAuth(options?: {
  allowKeychainPrompt?: boolean;
}): boolean;
declare function buildAnthropicCliMigrationResult(config: OpenClawConfig, credential?: ClaudeCliCredential | null): ProviderAuthResult;
//#endregion
export { buildAnthropicCliMigrationResult, hasClaudeCliAuth };