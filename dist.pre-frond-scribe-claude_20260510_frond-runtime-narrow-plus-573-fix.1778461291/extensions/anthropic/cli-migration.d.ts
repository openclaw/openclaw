import { i as OpenClawConfig } from "../../types.openclaw-CoVv5VQR.js";
import { _t as ProviderAuthResult } from "../../types-BYigPDoy.js";
import { n as readClaudeCliCredentialsForSetup } from "../../cli-auth-seam-DtC_Ury-.js";

//#region extensions/anthropic/cli-migration.d.ts
type ClaudeCliCredential = NonNullable<ReturnType<typeof readClaudeCliCredentialsForSetup>>;
declare function hasClaudeCliAuth(options?: {
  allowKeychainPrompt?: boolean;
}): boolean;
declare function buildAnthropicCliMigrationResult(config: OpenClawConfig, credential?: ClaudeCliCredential | null): ProviderAuthResult;
//#endregion
export { buildAnthropicCliMigrationResult, hasClaudeCliAuth };