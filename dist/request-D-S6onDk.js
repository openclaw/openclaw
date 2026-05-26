import { n as CodexAppServerRpcError } from "./client-Cnachic1.js";
import { a as getSharedCodexAppServerClient, i as createIsolatedCodexAppServerClient, o as withTimeout } from "./shared-client-3aMgN5po.js";
//#region extensions/codex/src/app-server/capabilities.ts
const CODEX_CONTROL_METHODS = {
	account: "account/read",
	compact: "thread/compact/start",
	feedback: "feedback/upload",
	listMcpServers: "mcpServerStatus/list",
	listSkills: "skills/list",
	listThreads: "thread/list",
	rateLimits: "account/rateLimits/read",
	resumeThread: "thread/resume",
	review: "review/start"
};
function describeControlFailure(error) {
	if (isUnsupportedControlError(error)) return "unsupported by this Codex app-server";
	return error instanceof Error ? error.message : String(error);
}
function isUnsupportedControlError(error) {
	return error instanceof CodexAppServerRpcError && error.code === -32601;
}
//#endregion
//#region extensions/codex/src/app-server/request.ts
async function requestCodexAppServerJson(params) {
	const timeoutMs = params.timeoutMs ?? 6e4;
	return await withTimeout((async () => {
		const client = await (params.isolated ? createIsolatedCodexAppServerClient : getSharedCodexAppServerClient)({
			startOptions: params.startOptions,
			timeoutMs,
			authProfileId: params.authProfileId,
			agentDir: params.agentDir,
			config: params.config
		});
		try {
			return await client.request(params.method, params.requestParams, { timeoutMs });
		} finally {
			if (params.isolated) await client.closeAndWait({
				exitTimeoutMs: 2e3,
				forceKillDelayMs: 250
			});
		}
	})(), timeoutMs, `codex app-server ${params.method} timed out`);
}
//#endregion
export { CODEX_CONTROL_METHODS as n, describeControlFailure as r, requestCodexAppServerJson as t };
