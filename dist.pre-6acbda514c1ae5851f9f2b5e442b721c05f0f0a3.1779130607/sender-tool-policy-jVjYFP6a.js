import "./agent-scope-rw2bYM9R.js";
import { r as resolveAgentConfig } from "./agent-scope-config-DdvF1onI.js";
import { n as pickSandboxToolPolicy } from "./sandbox-tool-policy-DzeU9UkQ.js";
import { i as resolveToolsBySender } from "./group-policy-CycKiUc2.js";
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
