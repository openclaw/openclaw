import { i as OpenClawConfig } from "../../types.openclaw-C9E_zZnO.js";
import { _t as ProviderAuthResult } from "../../types-DaukV8xd.js";
import { n as readClaudeCliCredentialsForSetup } from "../../cli-auth-seam-DPDYt7Br.js";

//#region extensions/anthropic/cli-migration.d.ts
type ClaudeCliCredential = NonNullable<ReturnType<typeof readClaudeCliCredentialsForSetup>>;
declare function hasClaudeCliAuth(options?: {
  allowKeychainPrompt?: boolean;
}): boolean;
declare function buildAnthropicCliMigrationResult(config: OpenClawConfig, credential?: ClaudeCliCredential | null): ProviderAuthResult;
//#endregion
export { buildAnthropicCliMigrationResult, hasClaudeCliAuth };