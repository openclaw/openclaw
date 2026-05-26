import { i as OpenClawConfig } from "../../types.openclaw-DIZy8jcb.js";
import { Tt as ProviderAuthResult } from "../../types-lCXG2pW_.js";
import { n as readClaudeCliCredentialsForSetup } from "../../cli-auth-seam-4MxhY2qj.js";
//#region extensions/anthropic/cli-migration.d.ts
type ClaudeCliCredential = NonNullable<ReturnType<typeof readClaudeCliCredentialsForSetup>>;
declare function hasClaudeCliAuth(options?: {
  allowKeychainPrompt?: boolean;
}): boolean;
declare function buildAnthropicCliMigrationResult(config: OpenClawConfig, credential?: ClaudeCliCredential | null): ProviderAuthResult;
//#endregion
export { buildAnthropicCliMigrationResult, hasClaudeCliAuth };