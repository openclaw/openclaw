import { t as readClaudeCliCredentialsForRuntime } from "../../cli-auth-seam-CIW1ksPk.js";
//#region extensions/anthropic/provider-discovery.ts
const CLAUDE_CLI_BACKEND_ID = "claude-cli";
function resolveClaudeCliSyntheticAuth() {
	const credential = readClaudeCliCredentialsForRuntime();
	if (!credential) return;
	return credential.type === "oauth" ? {
		apiKey: credential.access,
		source: "Claude CLI native auth",
		mode: "oauth",
		expiresAt: credential.expires
	} : {
		apiKey: credential.token,
		source: "Claude CLI native auth",
		mode: "token",
		expiresAt: credential.expires
	};
}
const anthropicProviderDiscovery = {
	id: CLAUDE_CLI_BACKEND_ID,
	label: "Claude CLI",
	docsPath: "/providers/models",
	auth: [],
	resolveSyntheticAuth: ({ provider }) => provider === CLAUDE_CLI_BACKEND_ID ? resolveClaudeCliSyntheticAuth() : void 0
};
//#endregion
export { anthropicProviderDiscovery as default };
