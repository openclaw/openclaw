import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, d as normalizeStringifiedOptionalString, f as readStringValue, i as normalizeFastMode, l as normalizeOptionalStringifiedId, n as localeLowercasePreservingWhitespace, o as normalizeNullableString, p as resolvePrimaryStringValue, r as lowercasePreservingWhitespace, s as normalizeOptionalLowercaseString, t as hasNonEmptyString, u as normalizeOptionalThreadValue } from "../../string-coerce-LndEvhRk.js";
import { a as redactToolDetail, i as redactSensitiveText, r as redactSensitiveLines, s as resolveRedactOptions, t as getDefaultRedactPatterns } from "../../redact-BWh2xM0E.js";
import { n as resolveGlobalSingleton, t as resolveGlobalMap } from "../../global-singleton-Bq6e5lAP.js";
import { u as withTimeout } from "../../fs-safe-Cwlcdma7.js";
import { _ as sleep, a as displayPath, b as escapeRegExp, c as isRecord, d as resolveConfigDir, f as resolveHomeDir, g as shortenHomePath, h as shortenHomeInString, i as clampNumber, l as normalizeE164, m as safeParseJson, n as clamp, o as displayString, p as resolveUserPath, r as clampInt, s as ensureDir, t as CONFIG_DIR, u as pathExists, v as sliceUtf16Safe, y as truncateUtf16Safe } from "../../utils-DG9b7Tlg.js";
import { a as normalizeOptionalTrimmedStringList, c as normalizeStringEntriesLower, i as normalizeHyphenSlug, l as normalizeTrimmedStringList, n as normalizeAtHashSlug, o as normalizeSingleOrTrimmedStringList, r as normalizeCsvOrLooseStringList, s as normalizeStringEntries, t as normalizeArrayBackedTrimmedStringList } from "../../string-normalization-DgUPESoD.js";
import { a as getLogger, c as resetLogger, d as toPinoLikeLogger, i as getChildLogger, n as DEFAULT_LOG_FILE, o as getResolvedLoggerSettings, r as __test__, s as isFileLogLevelEnabled, t as DEFAULT_LOG_DIR, u as setLoggerOverride } from "../../logger-CM9YQbLE.js";
import { a as logWarn, i as logSuccess, n as logError, r as logInfo, t as logDebug } from "../../logger-D3H65hS5.js";
import { t as sanitizeTerminalText } from "../../safe-text-2kp1UoUr.js";
import { a as asRecord, i as asOptionalRecord, n as asNullableRecord, o as readStringField, r as asOptionalObjectRecord, t as asNullableObjectRecord } from "../../record-coerce-vG6M9XAt.js";
import { n as sha256HexPrefix, t as redactIdentifier } from "../../redact-identifier-D70Q7DFj.js";
import { _ as stopDiagnosticHeartbeat, a as logRunAttempt, c as logToolLoopAction, d as logWebhookReceived, g as startDiagnosticHeartbeat, h as resolveStuckSessionWarnMs, i as logMessageQueued, l as logWebhookError, n as logActiveRuns, p as resetDiagnosticStateForTest, r as logMessageProcessed, s as logSessionStateChange, t as getDiagnosticSessionStateCountForTest, u as logWebhookProcessed } from "../../diagnostic-Cw0ETe6T.js";
import { i as logLaneEnqueue, r as logLaneDequeue, t as diagnosticLogger } from "../../diagnostic-runtime-BGgDVtlL.js";
import { a as stripInlineDirectiveTagsFromMessageForDisplay, i as stripInlineDirectiveTagsForDisplay, n as sanitizeReplyDirectiveId, r as stripInlineDirectiveTagsForDelivery, t as parseInlineDirectives } from "../../directive-tags-BUUa0lFe.js";
import { a as stripDowngradedToolCallText, c as stripToolCallXmlTags, f as findCodeRegions, i as stripAssistantInternalScaffolding, l as hasOrphanReasoningCloseBoundary, n as sanitizeAssistantVisibleTextWithOptions, p as isInsideCode, r as sanitizeAssistantVisibleTextWithProfile, s as stripMinimaxToolCallXml, t as sanitizeAssistantVisibleText, u as stripReasoningTagsFromText } from "../../assistant-visible-text-Dn8SLG3L.js";
import { n as buildTimeoutAbortSignal, r as fetchWithTimeout, t as bindAbortRelay } from "../../fetch-timeout-Dqifo5D9.js";
import { a as markdownToIRWithMeta, i as markdownToIR, n as renderMarkdownWithMarkers, o as sliceMarkdownIR, r as chunkMarkdownIR, t as convertMarkdownTables } from "../../tables-T6VynNYm.js";
import { i as renderMarkdownIRChunksWithinLimit, n as chunkItems, r as stripMarkdown, t as resolveReactionLevel } from "../../text-runtime-BFTVdjnu.js";
import { t as createScopedExpiringIdCache } from "../../scoped-expiring-id-cache-CiQqLNMv.js";
import { t as summarizeStringEntries } from "../../string-sample-Rph-W13I.js";
import { n as isAutoLinkedFileRef, t as FILE_REF_EXTENSIONS_WITH_TLD } from "../../auto-linked-file-ref-CLNf8axT.js";
import { n as hasSystemMark, r as prefixSystemMessage, t as SYSTEM_MARK } from "../../system-message-ZQcDvVNe.js";
import "../../core-DrKqe3wh.js";
import "../../account-resolution-Dv8-7lrj.js";
import "../../channel-actions-D67Km9Lw.js";
import { r as resolveDefaultWhatsAppAccountId, t as listAccountIds } from "../../account-ids-C0YWxoLR.js";
import { a as resolveWhatsAppAccount, i as listWhatsAppAuthDirs, n as hasAnyWhatsAppAuth, o as resolveWhatsAppAuthDir, r as listEnabledWhatsAppAccounts, s as resolveWhatsAppMediaMaxBytes, t as DEFAULT_WHATSAPP_MEDIA_MAX_MB } from "../../accounts-CTlHJW8H.js";
import { a as normalizeWhatsAppAllowFromEntries, c as normalizeWhatsAppTarget, i as looksLikeWhatsAppTargetId, r as isWhatsAppUserTarget, s as normalizeWhatsAppMessagingTarget, t as isWhatsAppGroupJid } from "../../normalize-target-ZP9Son35.js";
import { t as resolveWhatsAppOutboundTarget } from "../../resolve-outbound-target-DQ6enHa4.js";
import "../../reaction-level-C2g4Kaz2.js";
import { a as resolveJidToE164, i as markdownToWhatsApp, n as isSelfChatMode, o as toWhatsappJid, r as jidToE164, t as assertWebChannel } from "../../text-runtime-_06Ndayq.js";
import "../../send-C8N2nDjX.js";
import { t as whatsappPlugin } from "../../channel-CC3RzXiK.js";
import { n as WHATSAPP_LEGACY_OUTBOUND_SEND_DEP_KEYS } from "../../outbound-base-CRbnQ0Hj.js";
import { t as whatsappCommandPolicy } from "../../command-policy-KliAHSB_.js";
import { a as resolveWhatsAppGroupToolPolicy, i as resolveWhatsAppGroupRequireMention, o as resolveWhatsAppGroupIntroHint } from "../../shared-Ct9u446N.js";
import "../../config-schema-CyxMtTbt.js";
import { t as whatsappSetupPlugin } from "../../channel.setup-LTxfHPyv.js";
import { t as DEFAULT_WEB_MEDIA_BYTES } from "../../constants-DQaACaR0.js";
import { n as listWhatsAppDirectoryPeersFromConfig, t as listWhatsAppDirectoryGroupsFromConfig } from "../../directory-config-De8GCYio.js";
import { t as __testing } from "../../access-control-DZV6nYXa.js";
import { p as extractText, t as createWebSendApi } from "../../send-api-OOGrLVjP.js";
import { r as waitForWaConnection, t as createWaSocket } from "../../session-BUyYQgoD.js";
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
export { CONFIG_DIR, DEFAULT_LOG_DIR, DEFAULT_LOG_FILE, DEFAULT_WEB_MEDIA_BYTES, DEFAULT_WHATSAPP_MEDIA_MAX_MB, FILE_REF_EXTENSIONS_WITH_TLD, SYSTEM_MARK, WHATSAPP_LEGACY_OUTBOUND_SEND_DEP_KEYS, __test__, asNullableObjectRecord, asNullableRecord, asOptionalObjectRecord, asOptionalRecord, asRecord, assertWebChannel, bindAbortRelay, buildTimeoutAbortSignal, chunkItems, chunkMarkdownIR, clamp, clampInt, clampNumber, convertMarkdownTables, createScopedExpiringIdCache, diagnosticLogger, displayPath, displayString, ensureDir, escapeRegExp, fetchWithTimeout, findCodeRegions, getChildLogger, getDefaultRedactPatterns, getDiagnosticSessionStateCountForTest, getLogger, getResolvedLoggerSettings, hasAnyWhatsAppAuth, hasNonEmptyString, hasOrphanReasoningCloseBoundary, hasSystemMark, isAutoLinkedFileRef, isFileLogLevelEnabled, isInsideCode, isRecord, isSelfChatMode, isWhatsAppGroupJid, isWhatsAppUserTarget, jidToE164, listEnabledWhatsAppAccounts, listAccountIds as listWhatsAppAccountIds, listWhatsAppAuthDirs, listWhatsAppDirectoryGroupsFromConfig, listWhatsAppDirectoryPeersFromConfig, localeLowercasePreservingWhitespace, logActiveRuns, logDebug, logError, logInfo, logLaneDequeue, logLaneEnqueue, logMessageProcessed, logMessageQueued, logRunAttempt, logSessionStateChange, logSuccess, logToolLoopAction, logWarn, logWebhookError, logWebhookProcessed, logWebhookReceived, looksLikeWhatsAppTargetId, lowercasePreservingWhitespace, markdownToIR, markdownToIRWithMeta, markdownToWhatsApp, normalizeArrayBackedTrimmedStringList, normalizeAtHashSlug, normalizeCsvOrLooseStringList, normalizeE164, normalizeFastMode, normalizeHyphenSlug, normalizeLowercaseStringOrEmpty, normalizeNullableString, normalizeOptionalLowercaseString, normalizeOptionalString, normalizeOptionalStringifiedId, normalizeOptionalThreadValue, normalizeOptionalTrimmedStringList, normalizeSingleOrTrimmedStringList, normalizeStringEntries, normalizeStringEntriesLower, normalizeStringifiedOptionalString, normalizeTrimmedStringList, normalizeWhatsAppAllowFromEntries, normalizeWhatsAppMessagingTarget, normalizeWhatsAppTarget, parseInlineDirectives, pathExists, prefixSystemMessage, readStringField, readStringValue, redactIdentifier, redactSensitiveLines, redactSensitiveText, redactToolDetail, renderMarkdownIRChunksWithinLimit, renderMarkdownWithMarkers, resetDiagnosticStateForTest, resetLogger, resolveConfigDir, resolveDefaultWhatsAppAccountId, resolveGlobalMap, resolveGlobalSingleton, resolveHomeDir, resolveJidToE164, resolvePrimaryStringValue, resolveReactionLevel, resolveRedactOptions, resolveStuckSessionWarnMs, resolveUserPath, resolveWhatsAppAccount, resolveWhatsAppAuthDir, resolveWhatsAppGroupIntroHint, resolveWhatsAppGroupRequireMention, resolveWhatsAppGroupToolPolicy, resolveWhatsAppMediaMaxBytes, resolveWhatsAppOutboundTarget, safeParseJson, sanitizeAssistantVisibleText, sanitizeAssistantVisibleTextWithOptions, sanitizeAssistantVisibleTextWithProfile, sanitizeReplyDirectiveId, sanitizeTerminalText, setLoggerOverride, sha256HexPrefix, shortenHomeInString, shortenHomePath, sleep, sliceMarkdownIR, sliceUtf16Safe, startDiagnosticHeartbeat, startWhatsAppQaDriverSession, stopDiagnosticHeartbeat, stripAssistantInternalScaffolding, stripDowngradedToolCallText, stripInlineDirectiveTagsForDelivery, stripInlineDirectiveTagsForDisplay, stripInlineDirectiveTagsFromMessageForDisplay, stripMarkdown, stripMinimaxToolCallXml, stripReasoningTagsFromText, stripToolCallXmlTags, summarizeStringEntries, toPinoLikeLogger, toWhatsappJid, truncateUtf16Safe, __testing as whatsappAccessControlTesting, whatsappCommandPolicy, whatsappPlugin, whatsappSetupPlugin, withTimeout };
