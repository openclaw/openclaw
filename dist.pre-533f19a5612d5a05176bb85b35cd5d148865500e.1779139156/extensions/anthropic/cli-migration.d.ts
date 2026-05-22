import { i as OpenClawConfig } from "../../types.openclaw-Bpxi7OSY.js";
import { At as ProviderAuthResult } from "../../types-Cdl1yOYR.js";
import { n as readClaudeCliCredentialsForSetup } from "../../cli-auth-seam-IC2g-KMk.js";
//#region extensions/anthropic/cli-migration.d.ts
type ClaudeCliCredential = NonNullable<ReturnType<typeof readClaudeCliCredentialsForSetup>>;
declare function hasClaudeCliAuth(options?: {
  allowKeychainPrompt?: boolean;
}): boolean;
declare function buildAnthropicCliMigrationResult(config: OpenClawConfig, credential?: ClaudeCliCredential | null): ProviderAuthResult;
//#endregion
export { buildAnthropicCliMigrationResult, hasClaudeCliAuth };