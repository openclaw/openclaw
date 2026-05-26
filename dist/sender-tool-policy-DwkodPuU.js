import "./agent-scope-CtLXGcWm.js";
import { r as resolveAgentConfig } from "./agent-scope-config-CMp71_27.js";
import { i as resolveToolsBySender } from "./group-policy-sKF5rlUN.js";
import { n as pickSandboxToolPolicy } from "./sandbox-tool-policy-A1J2EpRM.js";
//#region src/agents/sender-tool-policy.ts
function resolveSenderToolPolicy(params) {
	const cfg = params.config;
	if (!cfg) return;
	const sender = {
		messageProvider: params.messageProvider,
		senderId: params.senderId,
		senderName: params.senderName,
		senderUsername: params.senderUsername,
		senderE164: params.senderE164
	};
	const agentPolicy = resolveToolsBySender({
		toolsBySender: (params.agentId && params.agentId.trim() ? resolveAgentConfig(cfg, params.agentId)?.tools : void 0)?.toolsBySender,
		...sender
	});
	if (agentPolicy) return pickSandboxToolPolicy(agentPolicy);
	return pickSandboxToolPolicy(resolveToolsBySender({
		toolsBySender: cfg.tools?.toolsBySender,
		...sender
	}));
}
//#endregion
export { resolveSenderToolPolicy as t };
