import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { n as resolveAgentIdentity, r as resolveEffectiveMessagesConfig } from "./identity-nYw-h8DL.js";
import { t as extractShortModelName } from "./response-prefix-template-coKH_22f.js";
//#region src/channels/reply-prefix.ts
function createReplyPrefixContext(params) {
	const { cfg, agentId } = params;
	const prefixContext = { identityName: normalizeOptionalString(resolveAgentIdentity(cfg, agentId)?.name) };
	const onModelSelected = (ctx) => {
		prefixContext.provider = ctx.provider;
		prefixContext.model = extractShortModelName(ctx.model);
		prefixContext.modelFull = `${ctx.provider}/${ctx.model}`;
		prefixContext.thinkingLevel = ctx.thinkLevel ?? "off";
	};
	return {
		prefixContext,
		responsePrefix: resolveEffectiveMessagesConfig(cfg, agentId, {
			channel: params.channel,
			accountId: params.accountId
		}).responsePrefix,
		responsePrefixContextProvider: () => prefixContext,
		onModelSelected
	};
}
function createReplyPrefixOptions(params) {
	const { responsePrefix, responsePrefixContextProvider, onModelSelected } = createReplyPrefixContext(params);
	return {
		responsePrefix,
		responsePrefixContextProvider,
		onModelSelected
	};
}
//#endregion
export { createReplyPrefixOptions as n, createReplyPrefixContext as t };
