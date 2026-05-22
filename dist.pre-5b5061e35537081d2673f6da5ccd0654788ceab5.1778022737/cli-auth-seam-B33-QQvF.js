import { O as readClaudeCliCredentialsCached } from "./store-Cmn8Tc5V.js";
import "./provider-auth-DdJrsFPl.js";
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
