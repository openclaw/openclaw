import { c as normalizeOptionalString, f as readStringValue } from "./string-coerce-DyL154ka.js";
import { c as isRecord$1 } from "./utils-sBTEdeml.js";
import { o as coerceSecretRef } from "./types.secrets-DwPik3M8.js";
import { n as normalizeAccountId, r as normalizeOptionalAccountId, t as DEFAULT_ACCOUNT_ID } from "./account-id-B32J-iNN.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { c as resolveMergedAccountConfig, i as hasConfiguredAccountValue, t as createAccountListHelpers } from "./account-helpers-BEXOONiv.js";
import "./provider-auth-BtRKd5us.js";
import "./account-resolution-Dy8RKAMt.js";
//#region extensions/feishu/src/comment-target.ts
const FEISHU_COMMENT_FILE_TYPES = [
	"doc",
	"docx",
	"file",
	"sheet",
	"slides"
];
function normalizeCommentFileType(value) {
	return typeof value === "string" && FEISHU_COMMENT_FILE_TYPES.includes(value) ? value : void 0;
}
function buildFeishuCommentTarget(params) {
	return `comment:${params.fileType}:${params.fileToken}:${params.commentId}`;
}
function parseFeishuCommentTarget(raw) {
	const trimmed = raw?.trim();
	if (!trimmed?.startsWith("comment:")) return null;
	const parts = trimmed.split(":");
	if (parts.length !== 4) return null;
	const fileType = normalizeCommentFileType(parts[1]);
	const fileToken = parts[2]?.trim();
	const commentId = parts[3]?.trim();
	if (!fileType || !fileToken || !commentId) return null;
	return {
		fileType,
		fileToken,
		commentId
	};
}
//#endregion
//#region extensions/feishu/src/comment-shared.ts
function encodeQuery(params) {
	const query = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		const trimmed = value?.trim();
		if (trimmed) query.set(key, trimmed);
	}
	const queryString = query.toString();
	return queryString ? `?${queryString}` : "";
}
const readString = readStringValue;
const normalizeString = normalizeOptionalString;
const isRecord = isRecord$1;
function formatFeishuApiError(error, options = {}) {
	if (!isRecord(error)) return typeof error === "string" ? error : JSON.stringify(error);
	const config = isRecord(error.config) ? error.config : void 0;
	const response = isRecord(error.response) ? error.response : void 0;
	const responseData = isRecord(response?.data) ? response?.data : void 0;
	const feishuLogId = readString(responseData?.log_id) || (options.includeNestedErrorLogId ? readString(isRecord(responseData?.error) ? responseData.error.log_id : void 0) : void 0);
	const nestedError = isRecord(responseData?.error) ? responseData.error : void 0;
	return JSON.stringify({
		message: typeof error.message === "string" ? error.message : typeof error === "string" ? error : JSON.stringify(error),
		code: readString(error.code),
		method: readString(config?.method),
		url: readString(config?.url),
		...options.includeConfigParams ? { params: config?.params } : {},
		http_status: typeof response?.status === "number" ? response.status : void 0,
		feishu_code: typeof responseData?.code === "number" ? responseData.code : readString(responseData?.code),
		feishu_msg: readString(responseData?.msg),
		feishu_log_id: feishuLogId,
		feishu_troubleshooter: readString(responseData?.troubleshooter) || readString(nestedError?.troubleshooter)
	});
}
function formatFeishuApiFailure(error, errorPrefix, options = {}) {
	return `${errorPrefix}: ${formatFeishuApiError(error, options) || "unknown error"}`;
}
function createFeishuApiError(error, errorPrefix, options = {}) {
	return new Error(formatFeishuApiFailure(error, errorPrefix, options), { cause: error });
}
async function requestFeishuApi(request, errorPrefix, options = {}) {
	try {
		return await request();
	} catch (error) {
		throw createFeishuApiError(error, errorPrefix, options);
	}
}
function readDocsLinkUrl(element) {
	const docsLink = isRecord(element.docs_link) ? element.docs_link : void 0;
	return normalizeString(docsLink?.url) || normalizeString(docsLink?.link) || normalizeString(element.url) || normalizeString(element.link) || void 0;
}
function readMentionUserId(element) {
	const mention = isRecord(element.mention) ? element.mention : void 0;
	return normalizeString((isRecord(element.person) ? element.person : void 0)?.user_id) || normalizeString(mention?.user_id) || normalizeString(mention?.open_id) || normalizeString(element.mention_user) || normalizeString(element.user_id) || void 0;
}
function readMentionDisplayText(element, userId) {
	const mention = isRecord(element.mention) ? element.mention : void 0;
	const mentionName = normalizeString(mention?.name) || normalizeString(mention?.display_name) || normalizeString(element.name);
	return mentionName ? `@${mentionName}` : `@${userId}`;
}
function normalizeCommentText(parts) {
	return parts.join("").trim() || void 0;
}
function normalizeCommentSemanticText(parts) {
	return parts.join("").replace(/\s+/g, " ").trim() || void 0;
}
function readElementTextPreservingWhitespace(element) {
	return (isRecord(element.text_run) ? readString(element.text_run.content) || readString(element.text_run.text) : void 0) || readString(element.text) || readString(element.content) || readString(element.name) || void 0;
}
const FEISHU_LINK_TOKEN_MIN_LENGTH = 22;
const FEISHU_LINK_TOKEN_MAX_LENGTH = 28;
const COMMENT_LINK_KIND_ALIASES = new Map([
	["doc", "doc"],
	["docs", "doc"],
	["docx", "docx"],
	["sheet", "sheet"],
	["sheets", "sheet"],
	["slide", "slides"],
	["slides", "slides"],
	["file", "file"],
	["files", "file"],
	["wiki", "wiki"],
	["mindnote", "mindnote"],
	["mindnotes", "mindnote"],
	["bitable", "bitable"],
	["base", "base"]
]);
function isCommentFileType(value) {
	return typeof value === "string" && FEISHU_COMMENT_FILE_TYPES.includes(value);
}
function isReasonableFeishuLinkToken(token) {
	return typeof token === "string" && token.length >= FEISHU_LINK_TOKEN_MIN_LENGTH && token.length <= FEISHU_LINK_TOKEN_MAX_LENGTH;
}
function parseCommentLinkedDocumentPath(pathname) {
	const segments = pathname.split("/").map((segment) => segment.trim()).filter(Boolean);
	const offset = segments[0]?.toLowerCase() === "space" ? 1 : 0;
	const kind = COMMENT_LINK_KIND_ALIASES.get(segments[offset]?.toLowerCase() ?? "");
	const token = normalizeString(segments[offset + 1]);
	if (!kind || !isReasonableFeishuLinkToken(token)) return null;
	return {
		urlKind: kind,
		token
	};
}
function hasResolvedLinkedDocumentReference(link) {
	return link.urlKind !== "unknown" && (Boolean(link.resolvedObjToken) || Boolean(link.wikiNodeToken));
}
function resolveCommentLinkedDocumentFromUrl(params) {
	const link = {
		rawUrl: params.rawUrl,
		urlKind: "unknown"
	};
	try {
		const parsedPath = parseCommentLinkedDocumentPath(new URL(params.rawUrl).pathname);
		if (!parsedPath) return link;
		const { urlKind, token } = parsedPath;
		link.urlKind = urlKind;
		if (urlKind === "wiki") {
			link.urlKind = "wiki";
			link.wikiNodeToken = token;
		} else {
			link.resolvedObjType = urlKind;
			link.resolvedObjToken = token;
		}
		if (link.resolvedObjType && link.resolvedObjToken && isCommentFileType(link.resolvedObjType) && params.currentDocument?.fileType === link.resolvedObjType && params.currentDocument.fileToken === link.resolvedObjToken) link.isCurrentDocument = true;
		else if (link.resolvedObjType && link.resolvedObjToken && isCommentFileType(link.resolvedObjType)) link.isCurrentDocument = false;
	} catch {
		return link;
	}
	return link;
}
function parseCommentContentElements(params) {
	const elements = Array.isArray(params.elements) ? params.elements : [];
	const plainTextParts = [];
	const semanticTextParts = [];
	const mentions = [];
	const linkedDocuments = [];
	const botIds = new Set(Array.from(params.botOpenIds ?? []).map((value) => normalizeString(value)).filter((value) => Boolean(value)));
	const linkedDocumentKeys = /* @__PURE__ */ new Set();
	let botMentioned = false;
	for (const rawElement of elements) {
		if (!isRecord(rawElement)) continue;
		const element = rawElement;
		const type = normalizeString(element.type);
		const text = (type === "text_run" ? readElementTextPreservingWhitespace(element) : void 0) || (type === "text" ? readElementTextPreservingWhitespace(element) : void 0) || (type === "docs_link" || type === "link" ? readDocsLinkUrl(element) : void 0) || (type === "mention" || type === "mention_user" || type === "person" ? (() => {
			const userId = readMentionUserId(element);
			return userId ? readMentionDisplayText(element, userId) : void 0;
		})() : void 0) || readElementTextPreservingWhitespace(element) || void 0;
		if (type === "mention" || type === "mention_user" || type === "person") {
			const userId = readMentionUserId(element);
			if (userId) {
				const displayText = readMentionDisplayText(element, userId);
				const isBotMention = botIds.has(userId);
				mentions.push({
					userId,
					displayText,
					isBotMention
				});
				plainTextParts.push(displayText);
				if (!isBotMention) semanticTextParts.push(displayText);
				else botMentioned = true;
				continue;
			}
		}
		if (type === "docs_link" || type === "link") {
			const rawUrl = readDocsLinkUrl(element);
			if (rawUrl) {
				plainTextParts.push(rawUrl);
				semanticTextParts.push(rawUrl);
				const linkedDocument = resolveCommentLinkedDocumentFromUrl({
					rawUrl,
					currentDocument: params.currentDocument
				});
				if (hasResolvedLinkedDocumentReference(linkedDocument)) {
					const key = [
						linkedDocument.rawUrl,
						linkedDocument.urlKind,
						linkedDocument.resolvedObjType,
						linkedDocument.resolvedObjToken,
						linkedDocument.wikiNodeToken
					].join(":");
					if (!linkedDocumentKeys.has(key)) {
						linkedDocumentKeys.add(key);
						linkedDocuments.push(linkedDocument);
					}
				}
				continue;
			}
		}
		if (text) {
			plainTextParts.push(text);
			semanticTextParts.push(text);
		}
	}
	return {
		plainText: normalizeCommentText(plainTextParts),
		semanticText: normalizeCommentSemanticText(semanticTextParts),
		mentions,
		linkedDocuments,
		botMentioned
	};
}
function extractReplyText(reply) {
	if (!reply || !isRecord(reply.content)) return;
	return parseCommentContentElements({ elements: Array.isArray(reply.content.elements) ? reply.content.elements : [] }).plainText;
}
//#endregion
//#region extensions/feishu/src/accounts.ts
const { listAccountIds: listFeishuAccountIds, resolveDefaultAccountId } = createAccountListHelpers("feishu", {
	allowUnlistedDefaultAccount: true,
	hasImplicitDefaultAccount: (cfg) => {
		const feishu = cfg.channels?.feishu;
		return hasConfiguredAccountValue(feishu?.appId) && hasConfiguredAccountValue(feishu?.appSecret);
	}
});
function formatSecretRefLabel(ref) {
	return `${ref.source}:${ref.provider}:${ref.id}`;
}
var FeishuSecretRefUnavailableError = class extends Error {
	constructor(path, ref) {
		super(`${path}: unresolved SecretRef "${formatSecretRefLabel(ref)}". Resolve this command against an active gateway runtime snapshot before reading it.`);
		this.name = "FeishuSecretRefUnavailableError";
		this.path = path;
	}
};
function resolveFeishuSecretLike(params) {
	const asString = normalizeString(params.value);
	if (asString) return asString;
	const ref = coerceSecretRef(params.value);
	if (!ref) return;
	if (params.mode === "inspect") {
		if (params.allowEnvSecretRefRead && ref.source === "env") {
			const envValue = normalizeString(process.env[ref.id]);
			if (envValue) return envValue;
		}
		return;
	}
	throw new FeishuSecretRefUnavailableError(params.path, ref);
}
function resolveFeishuBaseCredentials(cfg, mode) {
	const appId = resolveFeishuSecretLike({
		value: cfg?.appId,
		path: "channels.feishu.appId",
		mode,
		allowEnvSecretRefRead: true
	});
	const appSecret = resolveFeishuSecretLike({
		value: cfg?.appSecret,
		path: "channels.feishu.appSecret",
		mode,
		allowEnvSecretRefRead: true
	});
	if (!appId || !appSecret) return null;
	return {
		appId,
		appSecret,
		domain: cfg?.domain ?? "feishu"
	};
}
function resolveFeishuEventSecrets(cfg, mode) {
	return {
		encryptKey: (cfg?.connectionMode ?? "websocket") === "webhook" ? resolveFeishuSecretLike({
			value: cfg?.encryptKey,
			path: "channels.feishu.encryptKey",
			mode,
			allowEnvSecretRefRead: true
		}) : normalizeString(cfg?.encryptKey),
		verificationToken: resolveFeishuSecretLike({
			value: cfg?.verificationToken,
			path: "channels.feishu.verificationToken",
			mode,
			allowEnvSecretRefRead: true
		})
	};
}
/**
* Resolve the default account selection and its source.
*/
function resolveDefaultFeishuAccountSelection(cfg) {
	const preferred = normalizeOptionalAccountId((cfg.channels?.feishu)?.defaultAccount);
	if (preferred) return {
		accountId: preferred,
		source: "explicit-default"
	};
	const ids = listFeishuAccountIds(cfg);
	if (ids.includes("default")) return {
		accountId: DEFAULT_ACCOUNT_ID,
		source: "mapped-default"
	};
	return {
		accountId: ids[0] ?? "default",
		source: "fallback"
	};
}
/**
* Resolve the default account ID.
*/
function resolveDefaultFeishuAccountId(cfg) {
	return resolveDefaultAccountId(cfg);
}
/**
* Merge top-level config with account-specific config.
* Account-specific fields override top-level fields.
*/
function mergeFeishuAccountConfig(cfg, accountId) {
	const feishuCfg = cfg.channels?.feishu;
	return resolveMergedAccountConfig({
		channelConfig: feishuCfg,
		accounts: feishuCfg?.accounts,
		accountId,
		omitKeys: ["defaultAccount"]
	});
}
function resolveFeishuCredentials(cfg, options) {
	const mode = options?.mode ?? (options?.allowUnresolvedSecretRef ? "inspect" : "strict");
	const base = resolveFeishuBaseCredentials(cfg, mode);
	if (!base) return null;
	const eventSecrets = resolveFeishuEventSecrets(cfg, mode);
	return {
		...base,
		...eventSecrets
	};
}
function inspectFeishuCredentials(cfg) {
	return resolveFeishuCredentials(cfg, { mode: "inspect" });
}
function buildResolvedFeishuAccount(params) {
	const hasExplicitAccountId = typeof params.accountId === "string" && params.accountId.trim() !== "";
	const defaultSelection = hasExplicitAccountId ? null : resolveDefaultFeishuAccountSelection(params.cfg);
	const accountId = hasExplicitAccountId ? normalizeAccountId(params.accountId) : defaultSelection?.accountId ?? "default";
	const selectionSource = hasExplicitAccountId ? "explicit" : defaultSelection?.source ?? "fallback";
	const baseEnabled = (params.cfg.channels?.feishu)?.enabled !== false;
	const merged = mergeFeishuAccountConfig(params.cfg, accountId);
	const accountEnabled = merged.enabled !== false;
	const enabled = baseEnabled && accountEnabled;
	const baseCreds = resolveFeishuBaseCredentials(merged, params.baseMode);
	const eventSecrets = resolveFeishuEventSecrets(merged, params.eventSecretMode);
	const accountName = merged.name;
	return {
		accountId,
		selectionSource,
		enabled,
		configured: Boolean(baseCreds),
		name: typeof accountName === "string" ? accountName.trim() || void 0 : void 0,
		appId: baseCreds?.appId,
		appSecret: baseCreds?.appSecret,
		encryptKey: eventSecrets.encryptKey,
		verificationToken: eventSecrets.verificationToken,
		domain: baseCreds?.domain ?? "feishu",
		config: merged
	};
}
/**
* Resolve a read-only Feishu account snapshot for CLI/config surfaces.
* Unresolved SecretRefs are treated as unavailable instead of throwing.
*/
function resolveFeishuAccount(params) {
	return buildResolvedFeishuAccount({
		...params,
		baseMode: "inspect",
		eventSecretMode: "inspect"
	});
}
/**
* Resolve a runtime Feishu account.
* Required app credentials stay strict; event-only secrets can be required by callers.
*/
function resolveFeishuRuntimeAccount(params, options) {
	return buildResolvedFeishuAccount({
		...params,
		baseMode: "strict",
		eventSecretMode: options?.requireEventSecrets ? "strict" : "inspect"
	});
}
/**
* List all enabled and configured accounts.
*/
function listEnabledFeishuAccounts(cfg) {
	return listFeishuAccountIds(cfg).map((accountId) => resolveFeishuAccount({
		cfg,
		accountId
	})).filter((account) => account.enabled && account.configured);
}
//#endregion
export { readString as _, resolveDefaultFeishuAccountId as a, normalizeCommentFileType as b, resolveFeishuCredentials as c, encodeQuery as d, extractReplyText as f, parseCommentContentElements as g, normalizeString as h, listFeishuAccountIds as i, resolveFeishuRuntimeAccount as l, isRecord as m, inspectFeishuCredentials as n, resolveDefaultFeishuAccountSelection as o, formatFeishuApiError as p, listEnabledFeishuAccounts as r, resolveFeishuAccount as s, FeishuSecretRefUnavailableError as t, createFeishuApiError as u, requestFeishuApi as v, parseFeishuCommentTarget as x, buildFeishuCommentTarget as y };
