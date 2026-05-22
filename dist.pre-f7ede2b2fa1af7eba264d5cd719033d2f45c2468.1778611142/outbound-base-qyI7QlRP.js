import { r as normalizeOptionalAccountId, t as DEFAULT_ACCOUNT_ID } from "./account-id-9_btbLFO.js";
import { x as sendTextMediaPayload } from "./reply-payload-BnEJNs4t.js";
import { n as resolveOutboundSendDep } from "./send-deps-CbD2yKmj.js";
import { i as listCombinedAccountIds, o as resolveListedDefaultAccountId } from "./account-helpers-DfYsQXd5.js";
import "./account-core-DQL1Bczt.js";
import { i as createAttachedChannelResultAdapter } from "./channel-send-result-IErhXmQ_.js";
import { o as toWhatsappJid } from "./text-runtime-6sdl2e11.js";
import { n as normalizeWhatsAppPayloadText, t as normalizeWhatsAppOutboundPayload } from "./outbound-media-contract-050LP-cU.js";
import { i as lookupInboundMessageMetaForTarget } from "./quoted-message-BHLxto4r.js";
//#region extensions/whatsapp/src/outbound-send-deps.ts
const WHATSAPP_LEGACY_OUTBOUND_SEND_DEP_KEYS = ["sendWhatsApp"];
//#endregion
//#region extensions/whatsapp/src/outbound-base.ts
function resolveQuoteLookupAccountId(cfg, accountId) {
	const explicitAccountId = normalizeOptionalAccountId(accountId);
	if (explicitAccountId) return explicitAccountId;
	const channelCfg = cfg?.channels?.whatsapp;
	return resolveListedDefaultAccountId({
		accountIds: listCombinedAccountIds({
			configuredAccountIds: channelCfg?.accounts && typeof channelCfg.accounts === "object" ? Object.keys(channelCfg.accounts).filter(Boolean) : [],
			fallbackAccountIdWhenEmpty: DEFAULT_ACCOUNT_ID
		}),
		configuredDefaultAccountId: normalizeOptionalAccountId(channelCfg?.defaultAccount)
	});
}
function createWhatsAppOutboundBase({ chunker, sendMessageWhatsApp, sendPollWhatsApp, shouldLogVerbose, resolveTarget, normalizeText = normalizeWhatsAppPayloadText, skipEmptyText = true }) {
	const resolveQuotedMessageKey = (params) => {
		const replyToId = params.replyToId?.trim();
		if (!replyToId) return;
		const targetJid = toWhatsappJid(params.to);
		const cachedMeta = lookupInboundMessageMetaForTarget(params.accountId, targetJid, replyToId);
		return {
			id: replyToId,
			remoteJid: cachedMeta?.remoteJid ?? targetJid,
			fromMe: cachedMeta?.fromMe ?? false,
			participant: cachedMeta?.participant,
			messageText: cachedMeta?.body
		};
	};
	const outbound = {
		deliveryMode: "gateway",
		chunker,
		chunkerMode: "text",
		textChunkLimit: 4e3,
		sanitizeText: ({ text }) => normalizeText(text),
		deliveryCapabilities: { durableFinal: {
			text: true,
			replyTo: true,
			messageSendingHooks: true
		} },
		pollMaxOptions: 12,
		resolveTarget,
		...createAttachedChannelResultAdapter({
			channel: "whatsapp",
			sendText: async ({ cfg, to, text, accountId, deps, gifPlayback, replyToId }) => {
				const normalizedText = normalizeText(text);
				if (skipEmptyText && !normalizedText) return { messageId: "" };
				const send = resolveOutboundSendDep(deps, "whatsapp", { legacyKeys: WHATSAPP_LEGACY_OUTBOUND_SEND_DEP_KEYS }) ?? sendMessageWhatsApp;
				const quotedMessageKey = resolveQuotedMessageKey({
					accountId: resolveQuoteLookupAccountId(cfg, accountId),
					to,
					replyToId
				});
				return await send(to, normalizedText, {
					verbose: false,
					cfg,
					accountId: accountId ?? void 0,
					gifPlayback,
					quotedMessageKey
				});
			},
			sendMedia: async ({ cfg, to, text, mediaUrl, mediaAccess, mediaLocalRoots, mediaReadFile, audioAsVoice, accountId, deps, gifPlayback, replyToId }) => {
				const send = resolveOutboundSendDep(deps, "whatsapp", { legacyKeys: WHATSAPP_LEGACY_OUTBOUND_SEND_DEP_KEYS }) ?? sendMessageWhatsApp;
				const quotedMessageKey = resolveQuotedMessageKey({
					accountId: resolveQuoteLookupAccountId(cfg, accountId),
					to,
					replyToId
				});
				return await send(to, normalizeText(text), {
					verbose: false,
					cfg,
					mediaUrl,
					mediaAccess,
					mediaLocalRoots,
					mediaReadFile,
					...audioAsVoice === void 0 ? {} : { audioAsVoice },
					accountId: accountId ?? void 0,
					gifPlayback,
					quotedMessageKey
				});
			},
			sendPoll: async ({ cfg, to, poll, accountId }) => await sendPollWhatsApp(to, poll, {
				verbose: shouldLogVerbose(),
				accountId: accountId ?? void 0,
				cfg
			})
		})
	};
	return {
		...outbound,
		sendPayload: async (ctx) => {
			if (ctx.payload.isError === true) return {
				channel: "whatsapp",
				messageId: ""
			};
			const payload = normalizeWhatsAppOutboundPayload(ctx.payload, { normalizeText });
			if (!payload.text && !(payload.mediaUrl || payload.mediaUrls?.length)) {
				if (ctx.payload.interactive || ctx.payload.presentation || ctx.payload.channelData) throw new Error("WhatsApp sendPayload does not support structured-only payloads without text or media.");
				return {
					channel: "whatsapp",
					messageId: ""
				};
			}
			return await sendTextMediaPayload({
				channel: "whatsapp",
				ctx: {
					...ctx,
					payload
				},
				adapter: outbound
			});
		}
	};
}
//#endregion
export { WHATSAPP_LEGACY_OUTBOUND_SEND_DEP_KEYS as n, createWhatsAppOutboundBase as t };
