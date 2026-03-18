//#region extensions/shared/config-schema-helpers.ts
function requireChannelOpenAllowFrom(params) {
	params.requireOpenAllowFrom({
		policy: params.policy,
		allowFrom: params.allowFrom,
		ctx: params.ctx,
		path: ["allowFrom"],
		message: `channels.${params.channel}.dmPolicy="open" requires channels.${params.channel}.allowFrom to include "*"`
	});
}
//#endregion
export { requireChannelOpenAllowFrom as t };
