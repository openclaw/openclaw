import { t as __exportAll } from "./rolldown-runtime-Cbj13DAv.js";
import { A as escapeRegExp, G as toWhatsappJid, at as getChildLogger, t as createSubsystemLogger } from "./subsystem-B3k5RmW0.js";
import { L as loadConfig } from "./model-selection-aaCyoEgM.js";
import { n as generateSecureUuid } from "./secure-random-Ds0euxCu.js";
import { n as resolveMarkdownTableMode } from "./markdown-tables-CbKfjRTh.js";
import { a as loadWebMedia } from "./ir-BdlSx5oD.js";
import { n as normalizePollInput } from "./polls-BKbIUHj7.js";
import { t as convertMarkdownTables } from "./tables-mj7YhBlC.js";
import { i as redactIdentifier, n as requireActiveWebListener } from "./active-listener-D1SjfVz1.js";

//#region src/markdown/whatsapp.ts
/**
* Convert standard Markdown formatting to WhatsApp-compatible markup.
*
* WhatsApp uses its own formatting syntax:
*   bold:          *text*
*   italic:        _text_
*   strikethrough: ~text~
*   monospace:     ```text```
*
* Standard Markdown uses:
*   bold:          **text** or __text__
*   italic:        *text* or _text_
*   strikethrough: ~~text~~
*   code:          `text` (inline) or ```text``` (block)
*
* The conversion preserves fenced code blocks and inline code,
* then converts bold and strikethrough markers.
*/
/** Placeholder tokens used during conversion to protect code spans. */
const FENCE_PLACEHOLDER = "\0FENCE";
const INLINE_CODE_PLACEHOLDER = "\0CODE";
/**
* Convert standard Markdown bold/italic/strikethrough to WhatsApp formatting.
*
* Order of operations matters:
* 1. Protect fenced code blocks (```...```) — already WhatsApp-compatible
* 2. Protect inline code (`...`) — leave as-is
* 3. Convert **bold** → *bold* and __bold__ → *bold*
* 4. Convert ~~strike~~ → ~strike~
* 5. Restore protected spans
*
* Italic *text* and _text_ are left alone since WhatsApp uses _text_ for italic
* and single * is already WhatsApp bold — no conversion needed for single markers.
*/
function markdownToWhatsApp(text) {
	if (!text) return text;
	const fences = [];
	let result = text.replace(/```[\s\S]*?```/g, (match) => {
		fences.push(match);
		return `${FENCE_PLACEHOLDER}${fences.length - 1}`;
	});
	const inlineCodes = [];
	result = result.replace(/`[^`\n]+`/g, (match) => {
		inlineCodes.push(match);
		return `${INLINE_CODE_PLACEHOLDER}${inlineCodes.length - 1}`;
	});
	result = result.replace(/\*\*(.+?)\*\*/g, "*$1*");
	result = result.replace(/__(.+?)__/g, "*$1*");
	result = result.replace(/~~(.+?)~~/g, "~$1~");
	result = result.replace(new RegExp(`${escapeRegExp(INLINE_CODE_PLACEHOLDER)}(\\d+)`, "g"), (_, idx) => inlineCodes[Number(idx)] ?? "");
	result = result.replace(new RegExp(`${escapeRegExp(FENCE_PLACEHOLDER)}(\\d+)`, "g"), (_, idx) => fences[Number(idx)] ?? "");
	return result;
}

//#endregion
//#region src/web/outbound.ts
var outbound_exports = /* @__PURE__ */ __exportAll({
	sendMessageWhatsApp: () => sendMessageWhatsApp,
	sendPollWhatsApp: () => sendPollWhatsApp,
	sendReactionWhatsApp: () => sendReactionWhatsApp
});
const outboundLog = createSubsystemLogger("gateway/channels/whatsapp").child("outbound");
async function sendMessageWhatsApp(to, body, options) {
	let text = body;
	const correlationId = generateSecureUuid();
	const startedAt = Date.now();
	const { listener: active, accountId: resolvedAccountId } = requireActiveWebListener(options.accountId);
	const tableMode = resolveMarkdownTableMode({
		cfg: loadConfig(),
		channel: "whatsapp",
		accountId: resolvedAccountId ?? options.accountId
	});
	text = convertMarkdownTables(text ?? "", tableMode);
	text = markdownToWhatsApp(text);
	const redactedTo = redactIdentifier(to);
	const logger = getChildLogger({
		module: "web-outbound",
		correlationId,
		to: redactedTo
	});
	try {
		const jid = toWhatsappJid(to);
		const redactedJid = redactIdentifier(jid);
		let mediaBuffer;
		let mediaType;
		let documentFileName;
		if (options.mediaUrl) {
			const media = await loadWebMedia(options.mediaUrl, { localRoots: options.mediaLocalRoots });
			const caption = text || void 0;
			mediaBuffer = media.buffer;
			mediaType = media.contentType;
			if (media.kind === "audio") mediaType = media.contentType === "audio/ogg" ? "audio/ogg; codecs=opus" : media.contentType ?? "application/octet-stream";
			else if (media.kind === "video") text = caption ?? "";
			else if (media.kind === "image") text = caption ?? "";
			else {
				text = caption ?? "";
				documentFileName = media.fileName;
			}
		}
		outboundLog.info(`Sending message -> ${redactedJid}${options.mediaUrl ? " (media)" : ""}`);
		logger.info({
			jid: redactedJid,
			hasMedia: Boolean(options.mediaUrl)
		}, "sending message");
		await active.sendComposingTo(to);
		const accountId = Boolean(options.accountId?.trim()) ? resolvedAccountId : void 0;
		const sendOptions = options.gifPlayback || accountId || documentFileName ? {
			...options.gifPlayback ? { gifPlayback: true } : {},
			...documentFileName ? { fileName: documentFileName } : {},
			accountId
		} : void 0;
		const messageId = (sendOptions ? await active.sendMessage(to, text, mediaBuffer, mediaType, sendOptions) : await active.sendMessage(to, text, mediaBuffer, mediaType))?.messageId ?? "unknown";
		const durationMs = Date.now() - startedAt;
		outboundLog.info(`Sent message ${messageId} -> ${redactedJid}${options.mediaUrl ? " (media)" : ""} (${durationMs}ms)`);
		logger.info({
			jid: redactedJid,
			messageId
		}, "sent message");
		return {
			messageId,
			toJid: jid
		};
	} catch (err) {
		logger.error({
			err: String(err),
			to: redactedTo,
			hasMedia: Boolean(options.mediaUrl)
		}, "failed to send via web session");
		throw err;
	}
}
async function sendReactionWhatsApp(chatJid, messageId, emoji, options) {
	const correlationId = generateSecureUuid();
	const { listener: active } = requireActiveWebListener(options.accountId);
	const redactedChatJid = redactIdentifier(chatJid);
	const logger = getChildLogger({
		module: "web-outbound",
		correlationId,
		chatJid: redactedChatJid,
		messageId
	});
	try {
		const redactedJid = redactIdentifier(toWhatsappJid(chatJid));
		outboundLog.info(`Sending reaction "${emoji}" -> message ${messageId}`);
		logger.info({
			chatJid: redactedJid,
			messageId,
			emoji
		}, "sending reaction");
		await active.sendReaction(chatJid, messageId, emoji, options.fromMe ?? false, options.participant);
		outboundLog.info(`Sent reaction "${emoji}" -> message ${messageId}`);
		logger.info({
			chatJid: redactedJid,
			messageId,
			emoji
		}, "sent reaction");
	} catch (err) {
		logger.error({
			err: String(err),
			chatJid: redactedChatJid,
			messageId,
			emoji
		}, "failed to send reaction via web session");
		throw err;
	}
}
async function sendPollWhatsApp(to, poll, options) {
	const correlationId = generateSecureUuid();
	const startedAt = Date.now();
	const { listener: active } = requireActiveWebListener(options.accountId);
	const redactedTo = redactIdentifier(to);
	const logger = getChildLogger({
		module: "web-outbound",
		correlationId,
		to: redactedTo
	});
	try {
		const jid = toWhatsappJid(to);
		const redactedJid = redactIdentifier(jid);
		const normalized = normalizePollInput(poll, { maxOptions: 12 });
		outboundLog.info(`Sending poll -> ${redactedJid}`);
		logger.info({
			jid: redactedJid,
			optionCount: normalized.options.length,
			maxSelections: normalized.maxSelections
		}, "sending poll");
		const messageId = (await active.sendPoll(to, normalized))?.messageId ?? "unknown";
		const durationMs = Date.now() - startedAt;
		outboundLog.info(`Sent poll ${messageId} -> ${redactedJid} (${durationMs}ms)`);
		logger.info({
			jid: redactedJid,
			messageId
		}, "sent poll");
		return {
			messageId,
			toJid: jid
		};
	} catch (err) {
		logger.error({
			err: String(err),
			to: redactedTo
		}, "failed to send poll via web session");
		throw err;
	}
}

//#endregion
export { markdownToWhatsApp as i, sendMessageWhatsApp as n, sendReactionWhatsApp as r, outbound_exports as t };