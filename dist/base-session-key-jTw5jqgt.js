import { t as buildAgentSessionKey } from "./resolve-route-C8IahAyG.js";
//#region src/infra/outbound/base-session-key.ts
function buildOutboundBaseSessionKey(params) {
	return buildAgentSessionKey({
		agentId: params.agentId,
		channel: params.channel,
		accountId: params.accountId,
		peer: params.peer,
		dmScope: params.cfg.session?.dmScope ?? "main",
		identityLinks: params.cfg.session?.identityLinks
	});
}
//#endregion
export { buildOutboundBaseSessionKey as t };
