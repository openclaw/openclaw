import { j as readClaudeCliCredentialsCached } from "./store-Cm1yBhEt.js";
import "./provider-auth-BdVaafmp.js";
//#region extensions/anthropic/cli-auth-seam.ts
function readClaudeCliCredentialsForSetup() {
	return readClaudeCliCredentialsCached();
}
function readClaudeCliCredentialsForSetupNonInteractive() {
	return readClaudeCliCredentialsCached({ allowKeychainPrompt: false });
}
function readClaudeCliCredentialsForRuntime() {
	return readClaudeCliCredentialsCached({ allowKeychainPrompt: false });
}
//#endregion
export { readClaudeCliCredentialsForSetup as n, readClaudeCliCredentialsForSetupNonInteractive as r, readClaudeCliCredentialsForRuntime as t };
