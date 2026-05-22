import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { a as normalizeAnyChannelId } from "./registry-aY1NGwGo.js";
import { r as normalizeCommandBody } from "./commands-registry-normalize-CNDADEeJ.js";
import { o as stripMentions } from "./mentions-BmUnlrE8.js";
import { t as resolveCommandAuthorization } from "./command-auth-D4GV03Z1.js";
//#region src/auto-reply/reply/commands-context.ts
function buildCommandContext(params) {
	const { ctx, cfg, agentId, sessionKey, isGroup, triggerBodyNormalized } = params;
	const auth = resolveCommandAuthorization({
		ctx,
		cfg,
		commandAuthorized: params.commandAuthorized
	});
	const surface = normalizeLowercaseStringOrEmpty(ctx.Surface ?? ctx.Provider);
	const channel = normalizeLowercaseStringOrEmpty(ctx.OriginatingChannel ?? ctx.Provider ?? surface);
	const from = auth.from ?? normalizeOptionalString(ctx.SenderId);
	const to = auth.to ?? normalizeOptionalString(ctx.OriginatingTo);
	const abortKey = sessionKey ?? from ?? to;
	const channelId = normalizeAnyChannelId(channel) ?? (channel ? channel : void 0);
	const rawBodyNormalized = triggerBodyNormalized;
	const commandBodyNormalized = normalizeCommandBody(isGroup ? stripMentions(rawBodyNormalized, ctx, cfg, agentId) : rawBodyNormalized, { botUsername: ctx.BotUsername });
	return {
		surface,
		channel,
		channelId: channelId ?? auth.providerId,
		ownerList: auth.ownerList,
		senderIsOwner: auth.senderIsOwner,
		isAuthorizedSender: auth.isAuthorizedSender,
		senderId: auth.senderId,
		abortKey,
		rawBodyNormalized,
		commandBodyNormalized,
		from,
		to
	};
}
//#endregion
export { buildCommandContext as t };
