import { h as resolveReactionLevel, m as ResolvedReactionLevel, p as ReactionLevel } from "../../types.channels-CZZMDOR0.js";
import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, d as normalizeStringifiedOptionalString, f as readStringValue, i as normalizeFastMode, l as normalizeOptionalStringifiedId, n as localeLowercasePreservingWhitespace, o as normalizeNullableString, p as resolvePrimaryStringValue, r as lowercasePreservingWhitespace, s as normalizeOptionalLowercaseString, t as hasNonEmptyString, u as normalizeOptionalThreadValue } from "../../string-coerce-B5QyD596.js";
import { _ as sleep, a as displayPath, b as escapeRegExp, c as isRecord, d as resolveConfigDir, f as resolveHomeDir, g as shortenHomePath, h as shortenHomeInString, i as clampNumber, l as normalizeE164, m as safeParseJson, n as clamp, o as displayString, p as resolveUserPath, r as clampInt, s as ensureDir, t as CONFIG_DIR, u as pathExists, v as sliceUtf16Safe, y as truncateUtf16Safe } from "../../utils-D1CyDeib.js";
import { n as ChannelPlugin } from "../../types.public-D_xOTs5v.js";
import { t as convertMarkdownTables } from "../../tables-CKV9qix-.js";
import { a as normalizeOptionalTrimmedStringList, c as normalizeStringEntriesLower, i as normalizeHyphenSlug, l as normalizeTrimmedStringList, n as normalizeAtHashSlug, o as normalizeSingleOrTrimmedStringList, r as normalizeCsvOrLooseStringList, s as normalizeStringEntries, t as normalizeArrayBackedTrimmedStringList } from "../../string-normalization-DdThS6GG.js";
import { n as buildTimeoutAbortSignal, r as fetchWithTimeout, t as bindAbortRelay } from "../../fetch-timeout-Ba3XH_9i.js";
import { t as withTimeout } from "../../timing-BgGUSrRm.js";
import { a as redactSensitiveLines, l as resolveRedactOptions, n as ResolvedRedactOptions, o as redactSensitiveText, r as getDefaultRedactPatterns, s as redactToolDetail, t as RedactSensitiveMode } from "../../redact-DNHUZbwP.js";
import { n as resolveGlobalSingleton, t as resolveGlobalMap } from "../../global-singleton-cAP-NgSP.js";
import { a as __test__, c as getResolvedLoggerSettings, f as setLoggerOverride, h as LoggerSettings, i as PinoLikeLogger, l as isFileLogLevelEnabled, n as DEFAULT_LOG_FILE, o as getChildLogger, p as toPinoLikeLogger, r as LoggerResolvedSettings, s as getLogger, t as DEFAULT_LOG_DIR, u as resetLogger } from "../../logger-C4EO8KqN.js";
import { $ as logWebhookReceived, A as RenderedMarkdownChunk, B as markdownToIR, C as readStringField, D as RenderStyleMarker, E as RenderStyleMap, F as MarkdownStyle, G as logMessageProcessed, H as sliceMarkdownIR, I as MarkdownStyleSpan, K as logMessageQueued, L as MarkdownTableData, M as MarkdownIR, N as MarkdownLinkSpan, O as renderMarkdownWithMarkers, P as MarkdownParseOptions, Q as logWebhookProcessed, R as MarkdownTableMeta, S as asRecord, T as RenderOptions, U as getDiagnosticSessionStateCountForTest, V as markdownToIRWithMeta, W as logActiveRuns, X as logToolLoopAction, Y as logSessionStateChange, Z as logWebhookError, _ as summarizeStringEntries, a as sanitizeReplyDirectiveId, at as stopDiagnosticHeartbeat, b as asOptionalObjectRecord, c as stripInlineDirectiveTagsFromMessageForDisplay, ct as logLaneEnqueue, d as ReasoningTagTrim, dt as logInfo, f as hasOrphanReasoningCloseBoundary, ft as logSuccess, g as isInsideCode, h as findCodeRegions, i as parseInlineDirectives, it as startDiagnosticHeartbeat, j as renderMarkdownIRChunksWithinLimit, k as RenderMarkdownIRChunksWithinLimitOptions, l as stripMarkdown, lt as logDebug, m as CodeRegion, n as DisplayMessageWithContent, o as stripInlineDirectiveTagsForDelivery, ot as diagnosticLogger, p as stripReasoningTagsFromText, pt as logWarn, q as logRunAttempt, r as InlineDirectiveParseResult, rt as resolveStuckSessionWarnMs, s as stripInlineDirectiveTagsForDisplay, st as logLaneDequeue, t as chunkItems, tt as resetDiagnosticStateForTest, u as ReasoningTagMode, ut as logError, v as asNullableObjectRecord, w as RenderLink, x as asOptionalRecord, y as asNullableRecord, z as chunkMarkdownIR } from "../../text-runtime-CfuNr3Uw.js";
import { n as sha256HexPrefix, t as redactIdentifier } from "../../redact-identifier-aStTZF81.js";
import { n as createScopedExpiringIdCache, t as ScopedExpiringIdCache } from "../../scoped-expiring-id-cache-DTsSrAZC.js";
import { a as stripAssistantInternalScaffolding, c as stripMinimaxToolCallXml, i as sanitizeAssistantVisibleTextWithProfile, l as stripToolCallXmlTags, n as sanitizeAssistantVisibleText, o as stripDowngradedToolCallText, r as sanitizeAssistantVisibleTextWithOptions, t as AssistantVisibleTextSanitizerProfile } from "../../assistant-visible-text-CE93R8PQ.js";
import { n as isAutoLinkedFileRef, t as FILE_REF_EXTENSIONS_WITH_TLD } from "../../auto-linked-file-ref-B-76zzyk.js";
import { t as sanitizeTerminalText } from "../../safe-text-NaQYeE3K.js";
import { n as hasSystemMark, r as prefixSystemMessage, t as SYSTEM_MARK } from "../../system-message-DrZLKDUR.js";
import { a as listWhatsAppAuthDirs, c as resolveWhatsAppMediaMaxBytes, i as listEnabledWhatsAppAccounts, l as listAccountIds, n as ResolvedWhatsAppAccount, o as resolveWhatsAppAccount, r as hasAnyWhatsAppAuth, s as resolveWhatsAppAuthDir, t as DEFAULT_WHATSAPP_MEDIA_MAX_MB, u as resolveDefaultWhatsAppAccountId } from "../../accounts-CkTiOv4s.js";
import { t as whatsappPlugin } from "../../channel-DTYNjTQK.js";
import { t as whatsappSetupPlugin } from "../../channel.setup-pmoCGby4.js";
import { t as DEFAULT_WEB_MEDIA_BYTES } from "../../constants-BDGMN4UN.js";
import { a as resolveWhatsAppOutboundTarget, c as WebInboundMsg, d as resolveWhatsAppGroupToolPolicy, l as WebMonitorTuning, o as WebChannelHealthState, s as WebChannelStatus, t as resolveWhatsAppGroupIntroHint, u as resolveWhatsAppGroupRequireMention } from "../../runtime-api-wYplrRph.js";
import { A as isSelfChatMode, D as JidToE164Options, M as markdownToWhatsApp, N as resolveJidToE164, O as WebChannel, P as toWhatsappJid, j as jidToE164, k as assertWebChannel } from "../../session-errors-DcEKsWWM.js";
import { a as WhatsAppStructuredContactContext, i as WebListenerCloseReason, n as ActiveWebSendOptions, r as WebInboundMessage, t as ActiveWebListener } from "../../types-BqeYEFt1.js";
import { n as listWhatsAppDirectoryPeersFromConfig, t as listWhatsAppDirectoryGroupsFromConfig } from "../../directory-config-CXv-xXW2.js";
import { a as normalizeWhatsAppMessagingTarget, i as normalizeWhatsAppAllowFromEntries, n as isWhatsAppUserTarget, o as normalizeWhatsAppTarget, r as looksLikeWhatsAppTargetId, t as isWhatsAppGroupJid } from "../../normalize-target-l2-fdQ_6.js";
import { t as resolveWhatsAppInboundPolicy } from "../../inbound-policy-hIP18D75.js";

//#region extensions/whatsapp/src/command-policy.d.ts
declare const whatsappCommandPolicy: NonNullable<ChannelPlugin["commands"]>;
//#endregion
//#region extensions/whatsapp/src/outbound-send-deps.d.ts
declare const WHATSAPP_LEGACY_OUTBOUND_SEND_DEP_KEYS: readonly ["sendWhatsApp"];
//#endregion
//#region extensions/whatsapp/src/inbound/access-control.d.ts
declare const __testing: {
  resolveWhatsAppInboundPolicy: typeof resolveWhatsAppInboundPolicy;
};
//#endregion
//#region extensions/whatsapp/src/qa-driver.runtime.d.ts
type WhatsAppQaDriverObservedMessage = {
  fromJid?: string;
  fromPhoneE164?: string | null;
  messageId?: string;
  observedAt: string;
  text: string;
};
type WhatsAppQaDriverSession = {
  close: () => Promise<void>;
  getObservedMessages: () => WhatsAppQaDriverObservedMessage[];
  sendText: (to: string, text: string) => Promise<{
    messageId?: string;
  }>;
  waitForMessage: (params: {
    match: (message: WhatsAppQaDriverObservedMessage) => boolean;
    timeoutMs: number;
  }) => Promise<WhatsAppQaDriverObservedMessage>;
};
declare function startWhatsAppQaDriverSession(params: {
  authDir: string;
  connectionTimeoutMs?: number;
}): Promise<WhatsAppQaDriverSession>;
//#endregion
export { type ActiveWebListener, type ActiveWebSendOptions, type AssistantVisibleTextSanitizerProfile, CONFIG_DIR, type CodeRegion, DEFAULT_LOG_DIR, DEFAULT_LOG_FILE, DEFAULT_WEB_MEDIA_BYTES, DEFAULT_WHATSAPP_MEDIA_MAX_MB, type DisplayMessageWithContent, FILE_REF_EXTENSIONS_WITH_TLD, type InlineDirectiveParseResult, type JidToE164Options, type LoggerResolvedSettings, type LoggerSettings, type MarkdownIR, type MarkdownLinkSpan, type MarkdownParseOptions, type MarkdownStyle, type MarkdownStyleSpan, type MarkdownTableData, type MarkdownTableMeta, type PinoLikeLogger, type ReactionLevel, type ReasoningTagMode, type ReasoningTagTrim, type RedactSensitiveMode, type RenderLink, type RenderMarkdownIRChunksWithinLimitOptions, type RenderOptions, type RenderStyleMap, type RenderStyleMarker, type RenderedMarkdownChunk, type ResolvedReactionLevel, type ResolvedRedactOptions, type ResolvedWhatsAppAccount, SYSTEM_MARK, type ScopedExpiringIdCache, WHATSAPP_LEGACY_OUTBOUND_SEND_DEP_KEYS, type WebChannel, type WebChannelHealthState, type WebChannelStatus, type WebInboundMessage, type WebInboundMsg, type WebListenerCloseReason, type WebMonitorTuning, type WhatsAppQaDriverObservedMessage, type WhatsAppQaDriverSession, type WhatsAppStructuredContactContext, __test__, asNullableObjectRecord, asNullableRecord, asOptionalObjectRecord, asOptionalRecord, asRecord, assertWebChannel, bindAbortRelay, buildTimeoutAbortSignal, chunkItems, chunkMarkdownIR, clamp, clampInt, clampNumber, convertMarkdownTables, createScopedExpiringIdCache, diagnosticLogger, displayPath, displayString, ensureDir, escapeRegExp, fetchWithTimeout, findCodeRegions, getChildLogger, getDefaultRedactPatterns, getDiagnosticSessionStateCountForTest, getLogger, getResolvedLoggerSettings, hasAnyWhatsAppAuth, hasNonEmptyString, hasOrphanReasoningCloseBoundary, hasSystemMark, isAutoLinkedFileRef, isFileLogLevelEnabled, isInsideCode, isRecord, isSelfChatMode, isWhatsAppGroupJid, isWhatsAppUserTarget, jidToE164, listEnabledWhatsAppAccounts, listAccountIds as listWhatsAppAccountIds, listWhatsAppAuthDirs, listWhatsAppDirectoryGroupsFromConfig, listWhatsAppDirectoryPeersFromConfig, localeLowercasePreservingWhitespace, logActiveRuns, logDebug, logError, logInfo, logLaneDequeue, logLaneEnqueue, logMessageProcessed, logMessageQueued, logRunAttempt, logSessionStateChange, logSuccess, logToolLoopAction, logWarn, logWebhookError, logWebhookProcessed, logWebhookReceived, looksLikeWhatsAppTargetId, lowercasePreservingWhitespace, markdownToIR, markdownToIRWithMeta, markdownToWhatsApp, normalizeArrayBackedTrimmedStringList, normalizeAtHashSlug, normalizeCsvOrLooseStringList, normalizeE164, normalizeFastMode, normalizeHyphenSlug, normalizeLowercaseStringOrEmpty, normalizeNullableString, normalizeOptionalLowercaseString, normalizeOptionalString, normalizeOptionalStringifiedId, normalizeOptionalThreadValue, normalizeOptionalTrimmedStringList, normalizeSingleOrTrimmedStringList, normalizeStringEntries, normalizeStringEntriesLower, normalizeStringifiedOptionalString, normalizeTrimmedStringList, normalizeWhatsAppAllowFromEntries, normalizeWhatsAppMessagingTarget, normalizeWhatsAppTarget, parseInlineDirectives, pathExists, prefixSystemMessage, readStringField, readStringValue, redactIdentifier, redactSensitiveLines, redactSensitiveText, redactToolDetail, renderMarkdownIRChunksWithinLimit, renderMarkdownWithMarkers, resetDiagnosticStateForTest, resetLogger, resolveConfigDir, resolveDefaultWhatsAppAccountId, resolveGlobalMap, resolveGlobalSingleton, resolveHomeDir, resolveJidToE164, resolvePrimaryStringValue, resolveReactionLevel, resolveRedactOptions, resolveStuckSessionWarnMs, resolveUserPath, resolveWhatsAppAccount, resolveWhatsAppAuthDir, resolveWhatsAppGroupIntroHint, resolveWhatsAppGroupRequireMention, resolveWhatsAppGroupToolPolicy, resolveWhatsAppMediaMaxBytes, resolveWhatsAppOutboundTarget, safeParseJson, sanitizeAssistantVisibleText, sanitizeAssistantVisibleTextWithOptions, sanitizeAssistantVisibleTextWithProfile, sanitizeReplyDirectiveId, sanitizeTerminalText, setLoggerOverride, sha256HexPrefix, shortenHomeInString, shortenHomePath, sleep, sliceMarkdownIR, sliceUtf16Safe, startDiagnosticHeartbeat, startWhatsAppQaDriverSession, stopDiagnosticHeartbeat, stripAssistantInternalScaffolding, stripDowngradedToolCallText, stripInlineDirectiveTagsForDelivery, stripInlineDirectiveTagsForDisplay, stripInlineDirectiveTagsFromMessageForDisplay, stripMarkdown, stripMinimaxToolCallXml, stripReasoningTagsFromText, stripToolCallXmlTags, summarizeStringEntries, toPinoLikeLogger, toWhatsappJid, truncateUtf16Safe, __testing as whatsappAccessControlTesting, whatsappCommandPolicy, whatsappPlugin, whatsappSetupPlugin, withTimeout };