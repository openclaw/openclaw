import { r as resolveAgentConfig } from "./agent-scope-config-26EcJVc0.js";
import "./agent-scope-C1Fl7gAf.js";
import { n as pickSandboxToolPolicy } from "./sandbox-tool-policy-7ufxS0Kx.js";
import { i as resolveToolsBySender } from "./group-policy-DONyxmU9.js";
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
