import { l as normalizeE164, p as resolveUserPath } from "../../utils-CRkrr5e6.js";
import "../../core-DJqj23Pm.js";
import "../../account-resolution-kYIUHdFH.js";
import "../../channel-actions-BE_JGbx7.js";
import { r as resolveDefaultWhatsAppAccountId, t as listAccountIds } from "../../account-ids-BBr5bDcU.js";
import { a as resolveWhatsAppAccount, i as listWhatsAppAuthDirs, n as hasAnyWhatsAppAuth, o as resolveWhatsAppAuthDir, r as listEnabledWhatsAppAccounts, s as resolveWhatsAppMediaMaxBytes, t as DEFAULT_WHATSAPP_MEDIA_MAX_MB } from "../../accounts-Dsj3Roan.js";
import { a as normalizeWhatsAppAllowFromEntries, c as normalizeWhatsAppTarget, i as looksLikeWhatsAppTargetId, r as isWhatsAppUserTarget, s as normalizeWhatsAppMessagingTarget, t as isWhatsAppGroupJid } from "../../normalize-target-B9It9CyZ.js";
import { t as resolveWhatsAppOutboundTarget } from "../../resolve-outbound-target-DF2inbWW.js";
import "../../reaction-level-BWh5dhJb.js";
import { a as resolveJidToE164, i as markdownToWhatsApp, n as isSelfChatMode, o as toWhatsappJid, r as jidToE164, s as toWhatsappJidWithLid, t as assertWebChannel } from "../../text-runtime-Y5zDNbwZ.js";
import "../../send-D5B-FrGy.js";
import { t as whatsappPlugin } from "../../channel-BowVTVaC.js";
import { n as WHATSAPP_LEGACY_OUTBOUND_SEND_DEP_KEYS } from "../../outbound-base-l_qF3xOM.js";
import { t as whatsappCommandPolicy } from "../../command-policy-ByjmvXk-.js";
import { a as resolveWhatsAppGroupToolPolicy, i as resolveWhatsAppGroupRequireMention, o as resolveWhatsAppGroupIntroHint } from "../../shared-BBy2WErI.js";
import "../../config-schema-lquBqm1a.js";
import { t as whatsappSetupPlugin } from "../../channel.setup-BOKupav7.js";
import { t as DEFAULT_WEB_MEDIA_BYTES } from "../../constants-geFSbcL1.js";
import { n as listWhatsAppDirectoryPeersFromConfig, t as listWhatsAppDirectoryGroupsFromConfig } from "../../directory-config-Cdh9P0tn.js";
import { t as __testing } from "../../access-control-Danx8RLq.js";
import { p as extractText, t as createWebSendApi } from "../../send-api-DOnRKUhD.js";
import { r as waitForWaConnection, t as createWaSocket } from "../../session-Cyg_GxhD.js";
//#region extensions/whatsapp/src/qa-driver.runtime.ts
function normalizeObservedMessage(message, authDir) {
	if (message.key.fromMe) return null;
	const text = extractText(message.message ?? void 0);
	if (!text) return null;
	const fromJid = message.key.remoteJid ?? void 0;
	return {
		fromJid,
		fromPhoneE164: fromJid ? jidToE164(fromJid, { authDir }) : null,
		messageId: message.key.id ?? void 0,
		observedAt: (/* @__PURE__ */ new Date()).toISOString(),
		text
	};
}
function closeSocket(sock) {
	const maybeEnd = sock.end;
	if (typeof maybeEnd === "function") {
		maybeEnd.call(sock);
		return;
	}
	const maybeClose = sock.ws?.close;
	if (typeof maybeClose === "function") maybeClose.call(sock.ws);
}
async function startWhatsAppQaDriverSession(params) {
	const sock = await createWaSocket(false, false, { authDir: params.authDir });
	const observedMessages = [];
	const waiters = [];
	let closed = false;
	const removeWaiter = (waiter) => {
		const index = waiters.indexOf(waiter);
		if (index >= 0) waiters.splice(index, 1);
		clearTimeout(waiter.timeout);
	};
	const observe = (message) => {
		observedMessages.push(message);
		for (const waiter of waiters.slice()) {
			if (!waiter.predicate(message)) continue;
			removeWaiter(waiter);
			waiter.resolve(message);
		}
	};
	const onMessagesUpsert = (event) => {
		for (const rawMessage of event.messages ?? []) {
			const observed = normalizeObservedMessage(rawMessage, params.authDir);
			if (observed) observe(observed);
		}
	};
	const removeMessageListener = () => {
		sock.ev.off?.("messages.upsert", onMessagesUpsert);
	};
	const closeSessionResources = (waiterError) => {
		if (closed) return;
		closed = true;
		for (const waiter of waiters.slice()) {
			removeWaiter(waiter);
			if (waiterError) waiter.reject(waiterError);
		}
		removeMessageListener();
		closeSocket(sock);
	};
	sock.ev.on("messages.upsert", onMessagesUpsert);
	let connectionTimeout;
	try {
		await Promise.race([waitForWaConnection(sock), new Promise((_, reject) => {
			connectionTimeout = setTimeout(() => reject(/* @__PURE__ */ new Error("timed out waiting for WhatsApp QA driver session")), params.connectionTimeoutMs ?? 45e3);
			connectionTimeout.unref?.();
		})]);
	} catch (error) {
		closeSessionResources(error instanceof Error ? error : /* @__PURE__ */ new Error("failed starting WhatsApp QA driver session"));
		throw error;
	} finally {
		if (connectionTimeout) clearTimeout(connectionTimeout);
	}
	const sendApi = createWebSendApi({
		sock,
		defaultAccountId: "qa-driver"
	});
	return {
		async close() {
			closeSessionResources(/* @__PURE__ */ new Error("WhatsApp QA driver session closed"));
		},
		getObservedMessages() {
			return [...observedMessages];
		},
		async sendText(to, text) {
			return { messageId: (await sendApi.sendMessage(to, text)).messageId };
		},
		async waitForMessage(params) {
			const existing = observedMessages.find(params.match);
			if (existing) return existing;
			return await new Promise((resolve, reject) => {
				const waiter = {
					predicate: params.match,
					resolve,
					reject,
					timeout: setTimeout(() => {
						removeWaiter(waiter);
						reject(/* @__PURE__ */ new Error("timed out waiting for WhatsApp QA driver message"));
					}, params.timeoutMs)
				};
				waiters.push(waiter);
			});
		}
	};
}
//#endregion
export { DEFAULT_WEB_MEDIA_BYTES, DEFAULT_WHATSAPP_MEDIA_MAX_MB, WHATSAPP_LEGACY_OUTBOUND_SEND_DEP_KEYS, assertWebChannel, hasAnyWhatsAppAuth, isSelfChatMode, isWhatsAppGroupJid, isWhatsAppUserTarget, jidToE164, listEnabledWhatsAppAccounts, listAccountIds as listWhatsAppAccountIds, listWhatsAppAuthDirs, listWhatsAppDirectoryGroupsFromConfig, listWhatsAppDirectoryPeersFromConfig, looksLikeWhatsAppTargetId, markdownToWhatsApp, normalizeE164, normalizeWhatsAppAllowFromEntries, normalizeWhatsAppMessagingTarget, normalizeWhatsAppTarget, resolveDefaultWhatsAppAccountId, resolveJidToE164, resolveUserPath, resolveWhatsAppAccount, resolveWhatsAppAuthDir, resolveWhatsAppGroupIntroHint, resolveWhatsAppGroupRequireMention, resolveWhatsAppGroupToolPolicy, resolveWhatsAppMediaMaxBytes, resolveWhatsAppOutboundTarget, startWhatsAppQaDriverSession, toWhatsappJid, toWhatsappJidWithLid, __testing as whatsappAccessControlTesting, whatsappCommandPolicy, whatsappPlugin, whatsappSetupPlugin };
