import { F as readClaudeCliCredentialsCached } from "./store-BMQkMM4l.js";
import "./provider-auth-BtRKd5us.js";
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
