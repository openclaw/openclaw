import { w as sleep } from "./utils-BiUV1eIQ.js";
import { Ay as extractOriginalFilename, Td as resolveChannelMediaMaxBytes, mS as isSilentReplyText, tv as loadWebMedia } from "./auth-profiles-DAOR1fRn.js";
import { r as normalizeStringEntries } from "./string-normalization-CJJOCyGw.js";
import { n as extensionForMime, r as getFileExtension, t as detectMime } from "./mime-h80iV1FL.js";
import { D as writeJsonFileAtomically, E as readJsonFileWithFallback, T as withFileLock$1 } from "./dm-policy-shared-QWD8iFx0.js";
import { d as loadOutboundMediaFromUrl } from "./compat-aC6dpiEb.js";
import { O as resolveMSTeamsCredentials, c as createMSTeamsAdapter, l as loadMSTeamsSdkWithAuth, s as readAccessToken, t as getMSTeamsRuntime } from "./runtime-DP3qTCtk.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
//#region extensions/msteams/src/storage.ts
function resolveMSTeamsStorePath(params) {
	if (params.storePath) return params.storePath;
	if (params.stateDir) return path.join(params.stateDir, params.filename);
	const env = params.env ?? process.env;
	const stateDir = params.homedir ? getMSTeamsRuntime().state.resolveStateDir(env, params.homedir) : getMSTeamsRuntime().state.resolveStateDir(env);
	return path.join(stateDir, params.filename);
}
//#endregion
//#region extensions/msteams/src/store-fs.ts
const STORE_LOCK_OPTIONS = {
	retries: {
		retries: 10,
		factor: 2,
		minTimeout: 100,
		maxTimeout: 1e4,
		randomize: true
	},
	stale: 3e4
};
async function readJsonFile(filePath, fallback) {
	return await readJsonFileWithFallback(filePath, fallback);
}
async function writeJsonFile(filePath, value) {
	await writeJsonFileAtomically(filePath, value);
}
async function ensureJsonFile(filePath, fallback) {
	try {
		await fs.promises.access(filePath);
	} catch {
		await writeJsonFile(filePath, fallback);
	}
}
async function withFileLock(filePath, fallback, fn) {
	await ensureJsonFile(filePath, fallback);
	return await withFileLock$1(filePath, STORE_LOCK_OPTIONS, async () => {
		return await fn();
	});
}
//#endregion
//#region extensions/msteams/src/polls.ts
const STORE_FILENAME$1 = "msteams-polls.json";
const MAX_POLLS = 1e3;
const POLL_TTL_MS = 720 * 60 * 60 * 1e3;
function isRecord$1(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function normalizeChoiceValue(value) {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed ? trimmed : null;
	}
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return null;
}
function extractSelections(value) {
	if (Array.isArray(value)) return value.map(normalizeChoiceValue).filter((entry) => Boolean(entry));
	const normalized = normalizeChoiceValue(value);
	if (!normalized) return [];
	if (normalized.includes(",")) return normalized.split(",").map((entry) => entry.trim()).filter(Boolean);
	return [normalized];
}
function readNestedValue(value, keys) {
	let current = value;
	for (const key of keys) {
		if (!isRecord$1(current)) return;
		current = current[key];
	}
	return current;
}
function readNestedString(value, keys) {
	const found = readNestedValue(value, keys);
	return typeof found === "string" && found.trim() ? found.trim() : void 0;
}
function extractMSTeamsPollVote(activity) {
	const value = activity?.value;
	if (!value || !isRecord$1(value)) return null;
	const pollId = readNestedString(value, ["openclawPollId"]) ?? readNestedString(value, ["pollId"]) ?? readNestedString(value, ["openclaw", "pollId"]) ?? readNestedString(value, [
		"openclaw",
		"poll",
		"id"
	]) ?? readNestedString(value, ["data", "openclawPollId"]) ?? readNestedString(value, ["data", "pollId"]) ?? readNestedString(value, [
		"data",
		"openclaw",
		"pollId"
	]);
	if (!pollId) return null;
	const directSelections = extractSelections(value.choices);
	const nestedSelections = extractSelections(readNestedValue(value, ["choices"]));
	const dataSelections = extractSelections(readNestedValue(value, ["data", "choices"]));
	const selections = directSelections.length > 0 ? directSelections : nestedSelections.length > 0 ? nestedSelections : dataSelections;
	if (selections.length === 0) return null;
	return {
		pollId,
		selections
	};
}
function buildMSTeamsPollCard(params) {
	const pollId = params.pollId ?? crypto.randomUUID();
	const maxSelections = typeof params.maxSelections === "number" && params.maxSelections > 1 ? Math.floor(params.maxSelections) : 1;
	const cappedMaxSelections = Math.min(Math.max(1, maxSelections), params.options.length);
	const choices = params.options.map((option, index) => ({
		title: option,
		value: String(index)
	}));
	const hint = cappedMaxSelections > 1 ? `Select up to ${cappedMaxSelections} option${cappedMaxSelections === 1 ? "" : "s"}.` : "Select one option.";
	const card = {
		type: "AdaptiveCard",
		version: "1.5",
		body: [
			{
				type: "TextBlock",
				text: params.question,
				wrap: true,
				weight: "Bolder",
				size: "Medium"
			},
			{
				type: "Input.ChoiceSet",
				id: "choices",
				isMultiSelect: cappedMaxSelections > 1,
				style: "expanded",
				choices
			},
			{
				type: "TextBlock",
				text: hint,
				wrap: true,
				isSubtle: true,
				spacing: "Small"
			}
		],
		actions: [{
			type: "Action.Submit",
			title: "Vote",
			data: {
				openclawPollId: pollId,
				pollId
			},
			msteams: {
				type: "messageBack",
				text: "openclaw poll vote",
				displayText: "Vote recorded",
				value: {
					openclawPollId: pollId,
					pollId
				}
			}
		}]
	};
	const fallbackLines = [`Poll: ${params.question}`, ...params.options.map((option, index) => `${index + 1}. ${option}`)];
	return {
		pollId,
		question: params.question,
		options: params.options,
		maxSelections: cappedMaxSelections,
		card,
		fallbackText: fallbackLines.join("\n")
	};
}
function parseTimestamp$1(value) {
	if (!value) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}
function pruneExpired$1(polls) {
	const cutoff = Date.now() - POLL_TTL_MS;
	const entries = Object.entries(polls).filter(([, poll]) => {
		return (parseTimestamp$1(poll.updatedAt ?? poll.createdAt) ?? 0) >= cutoff;
	});
	return Object.fromEntries(entries);
}
function pruneToLimit$1(polls) {
	const entries = Object.entries(polls);
	if (entries.length <= MAX_POLLS) return polls;
	entries.sort((a, b) => {
		return (parseTimestamp$1(a[1].updatedAt ?? a[1].createdAt) ?? 0) - (parseTimestamp$1(b[1].updatedAt ?? b[1].createdAt) ?? 0);
	});
	const keep = entries.slice(entries.length - MAX_POLLS);
	return Object.fromEntries(keep);
}
function normalizeMSTeamsPollSelections(poll, selections) {
	const maxSelections = Math.max(1, poll.maxSelections);
	const mapped = selections.map((entry) => Number.parseInt(entry, 10)).filter((value) => Number.isFinite(value)).filter((value) => value >= 0 && value < poll.options.length).map((value) => String(value));
	const limited = maxSelections > 1 ? mapped.slice(0, maxSelections) : mapped.slice(0, 1);
	return Array.from(new Set(limited));
}
function createMSTeamsPollStoreFs(params) {
	const filePath = resolveMSTeamsStorePath({
		filename: STORE_FILENAME$1,
		env: params?.env,
		homedir: params?.homedir,
		stateDir: params?.stateDir,
		storePath: params?.storePath
	});
	const empty = {
		version: 1,
		polls: {}
	};
	const readStore = async () => {
		const { value } = await readJsonFile(filePath, empty);
		return {
			version: 1,
			polls: pruneToLimit$1(pruneExpired$1(value.polls ?? {}))
		};
	};
	const writeStore = async (data) => {
		await writeJsonFile(filePath, data);
	};
	const createPoll = async (poll) => {
		await withFileLock(filePath, empty, async () => {
			const data = await readStore();
			data.polls[poll.id] = poll;
			await writeStore({
				version: 1,
				polls: pruneToLimit$1(data.polls)
			});
		});
	};
	const getPoll = async (pollId) => await withFileLock(filePath, empty, async () => {
		return (await readStore()).polls[pollId] ?? null;
	});
	const recordVote = async (params) => await withFileLock(filePath, empty, async () => {
		const data = await readStore();
		const poll = data.polls[params.pollId];
		if (!poll) return null;
		const normalized = normalizeMSTeamsPollSelections(poll, params.selections);
		poll.votes[params.voterId] = normalized;
		poll.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
		data.polls[poll.id] = poll;
		await writeStore({
			version: 1,
			polls: pruneToLimit$1(data.polls)
		});
		return poll;
	});
	return {
		createPoll,
		getPoll,
		recordVote
	};
}
//#endregion
//#region extensions/msteams/src/conversation-store-fs.ts
const STORE_FILENAME = "msteams-conversations.json";
const MAX_CONVERSATIONS = 1e3;
const CONVERSATION_TTL_MS = 365 * 24 * 60 * 60 * 1e3;
function parseTimestamp(value) {
	if (!value) return null;
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) return null;
	return parsed;
}
function pruneToLimit(conversations) {
	const entries = Object.entries(conversations);
	if (entries.length <= MAX_CONVERSATIONS) return conversations;
	entries.sort((a, b) => {
		return (parseTimestamp(a[1].lastSeenAt) ?? 0) - (parseTimestamp(b[1].lastSeenAt) ?? 0);
	});
	const keep = entries.slice(entries.length - MAX_CONVERSATIONS);
	return Object.fromEntries(keep);
}
function pruneExpired(conversations, nowMs, ttlMs) {
	let removed = false;
	const kept = {};
	for (const [conversationId, reference] of Object.entries(conversations)) {
		const lastSeenAt = parseTimestamp(reference.lastSeenAt);
		if (lastSeenAt != null && nowMs - lastSeenAt > ttlMs) {
			removed = true;
			continue;
		}
		kept[conversationId] = reference;
	}
	return {
		conversations: kept,
		removed
	};
}
function normalizeConversationId$1(raw) {
	return raw.split(";")[0] ?? raw;
}
function createMSTeamsConversationStoreFs(params) {
	const ttlMs = params?.ttlMs ?? CONVERSATION_TTL_MS;
	const filePath = resolveMSTeamsStorePath({
		filename: STORE_FILENAME,
		env: params?.env,
		homedir: params?.homedir,
		stateDir: params?.stateDir,
		storePath: params?.storePath
	});
	const empty = {
		version: 1,
		conversations: {}
	};
	const readStore = async () => {
		const { value } = await readJsonFile(filePath, empty);
		if (value.version !== 1 || !value.conversations || typeof value.conversations !== "object" || Array.isArray(value.conversations)) return empty;
		const nowMs = Date.now();
		const pruned = pruneExpired(value.conversations, nowMs, ttlMs).conversations;
		return {
			version: 1,
			conversations: pruneToLimit(pruned)
		};
	};
	const list = async () => {
		const store = await readStore();
		return Object.entries(store.conversations).map(([conversationId, reference]) => ({
			conversationId,
			reference
		}));
	};
	const get = async (conversationId) => {
		return (await readStore()).conversations[normalizeConversationId$1(conversationId)] ?? null;
	};
	const findByUserId = async (id) => {
		const target = id.trim();
		if (!target) return null;
		for (const entry of await list()) {
			const { conversationId, reference } = entry;
			if (reference.user?.aadObjectId === target) return {
				conversationId,
				reference
			};
			if (reference.user?.id === target) return {
				conversationId,
				reference
			};
		}
		return null;
	};
	const upsert = async (conversationId, reference) => {
		const normalizedId = normalizeConversationId$1(conversationId);
		await withFileLock(filePath, empty, async () => {
			const store = await readStore();
			store.conversations[normalizedId] = {
				...reference,
				lastSeenAt: (/* @__PURE__ */ new Date()).toISOString()
			};
			const nowMs = Date.now();
			store.conversations = pruneExpired(store.conversations, nowMs, ttlMs).conversations;
			store.conversations = pruneToLimit(store.conversations);
			await writeJsonFile(filePath, store);
		});
	};
	const remove = async (conversationId) => {
		const normalizedId = normalizeConversationId$1(conversationId);
		return await withFileLock(filePath, empty, async () => {
			const store = await readStore();
			if (!(normalizedId in store.conversations)) return false;
			delete store.conversations[normalizedId];
			await writeJsonFile(filePath, store);
			return true;
		});
	};
	return {
		upsert,
		get,
		list,
		remove,
		findByUserId
	};
}
//#endregion
//#region extensions/msteams/src/errors.ts
function formatUnknownError(err) {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	if (err === null) return "null";
	if (err === void 0) return "undefined";
	if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") return String(err);
	if (typeof err === "symbol") return err.description ?? err.toString();
	if (typeof err === "function") return err.name ? `[function ${err.name}]` : "[function]";
	try {
		return JSON.stringify(err) ?? "unknown error";
	} catch {
		return "unknown error";
	}
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function extractStatusCode(err) {
	if (!isRecord(err)) return null;
	const direct = err.statusCode ?? err.status;
	if (typeof direct === "number" && Number.isFinite(direct)) return direct;
	if (typeof direct === "string") {
		const parsed = Number.parseInt(direct, 10);
		if (Number.isFinite(parsed)) return parsed;
	}
	const response = err.response;
	if (isRecord(response)) {
		const status = response.status;
		if (typeof status === "number" && Number.isFinite(status)) return status;
		if (typeof status === "string") {
			const parsed = Number.parseInt(status, 10);
			if (Number.isFinite(parsed)) return parsed;
		}
	}
	return null;
}
function extractRetryAfterMs(err) {
	if (!isRecord(err)) return null;
	const direct = err.retryAfterMs ?? err.retry_after_ms;
	if (typeof direct === "number" && Number.isFinite(direct) && direct >= 0) return direct;
	const retryAfter = err.retryAfter ?? err.retry_after;
	if (typeof retryAfter === "number" && Number.isFinite(retryAfter)) return retryAfter >= 0 ? retryAfter * 1e3 : null;
	if (typeof retryAfter === "string") {
		const parsed = Number.parseFloat(retryAfter);
		if (Number.isFinite(parsed) && parsed >= 0) return parsed * 1e3;
	}
	const response = err.response;
	if (!isRecord(response)) return null;
	const headers = response.headers;
	if (!headers) return null;
	if (isRecord(headers)) {
		const raw = headers["retry-after"] ?? headers["Retry-After"];
		if (typeof raw === "string") {
			const parsed = Number.parseFloat(raw);
			if (Number.isFinite(parsed) && parsed >= 0) return parsed * 1e3;
		}
	}
	if (typeof headers === "object" && headers !== null && "get" in headers && typeof headers.get === "function") {
		const raw = headers.get("retry-after");
		if (raw) {
			const parsed = Number.parseFloat(raw);
			if (Number.isFinite(parsed) && parsed >= 0) return parsed * 1e3;
		}
	}
	return null;
}
/**
* Classify outbound send errors for safe retries and actionable logs.
*
* Important: We only mark errors as retryable when we have an explicit HTTP
* status code that indicates the message was not accepted (e.g. 429, 5xx).
* For transport-level errors where delivery is ambiguous, we prefer to avoid
* retries to reduce the chance of duplicate posts.
*/
function classifyMSTeamsSendError(err) {
	const statusCode = extractStatusCode(err);
	const retryAfterMs = extractRetryAfterMs(err);
	if (statusCode === 401 || statusCode === 403) return {
		kind: "auth",
		statusCode
	};
	if (statusCode === 429) return {
		kind: "throttled",
		statusCode,
		retryAfterMs: retryAfterMs ?? void 0
	};
	if (statusCode === 408 || statusCode != null && statusCode >= 500) return {
		kind: "transient",
		statusCode,
		retryAfterMs: retryAfterMs ?? void 0
	};
	if (statusCode != null && statusCode >= 400) return {
		kind: "permanent",
		statusCode
	};
	return {
		kind: "unknown",
		statusCode: statusCode ?? void 0,
		retryAfterMs: retryAfterMs ?? void 0
	};
}
/**
* Detect whether an error is caused by a revoked Proxy.
*
* The Bot Framework SDK wraps TurnContext in a Proxy that is revoked once the
* turn handler returns.  Any later access (e.g. from a debounced callback)
* throws a TypeError whose message contains the distinctive "proxy that has
* been revoked" string.
*/
function isRevokedProxyError(err) {
	if (!(err instanceof TypeError)) return false;
	return /proxy that has been revoked/i.test(err.message);
}
function formatMSTeamsSendErrorHint(classification) {
	if (classification.kind === "auth") return "check msteams appId/appPassword/tenantId (or env vars MSTEAMS_APP_ID/MSTEAMS_APP_PASSWORD/MSTEAMS_TENANT_ID)";
	if (classification.kind === "throttled") return "Teams throttled the bot; backing off may help";
	if (classification.kind === "transient") return "transient Teams/Bot Framework error; retry may succeed";
}
//#endregion
//#region extensions/msteams/src/file-consent.ts
/**
* Build a FileConsentCard attachment for requesting upload permission.
* Use this for files >= 4MB in personal (1:1) chats.
*/
function buildFileConsentCard(params) {
	return {
		contentType: "application/vnd.microsoft.teams.card.file.consent",
		name: params.filename,
		content: {
			description: params.description ?? `File: ${params.filename}`,
			sizeInBytes: params.sizeInBytes,
			acceptContext: {
				filename: params.filename,
				...params.context
			},
			declineContext: {
				filename: params.filename,
				...params.context
			}
		}
	};
}
/**
* Build a FileInfoCard attachment for confirming upload completion.
* Send this after successfully uploading the file to the consent URL.
*/
function buildFileInfoCard(params) {
	return {
		contentType: "application/vnd.microsoft.teams.card.file.info",
		contentUrl: params.contentUrl,
		name: params.filename,
		content: {
			uniqueId: params.uniqueId,
			fileType: params.fileType
		}
	};
}
/**
* Parse a fileConsent/invoke activity.
* Returns null if the activity is not a file consent invoke.
*/
function parseFileConsentInvoke(activity) {
	if (activity.name !== "fileConsent/invoke") return null;
	const value = activity.value;
	if (value?.type !== "fileUpload") return null;
	return {
		action: value.action === "accept" ? "accept" : "decline",
		uploadInfo: value.uploadInfo,
		context: value.context
	};
}
/**
* Upload a file to the consent URL provided by Teams.
* The URL is provided in the fileConsent/invoke response after user accepts.
*/
async function uploadToConsentUrl(params) {
	const res = await (params.fetchFn ?? fetch)(params.url, {
		method: "PUT",
		headers: {
			"Content-Type": params.contentType ?? "application/octet-stream",
			"Content-Range": `bytes 0-${params.buffer.length - 1}/${params.buffer.length}`
		},
		body: new Uint8Array(params.buffer)
	});
	if (!res.ok) throw new Error(`File upload to consent URL failed: ${res.status} ${res.statusText}`);
}
//#endregion
//#region extensions/msteams/src/pending-uploads.ts
/**
* In-memory storage for files awaiting user consent in the FileConsentCard flow.
*
* When sending large files (>=4MB) in personal chats, Teams requires user consent
* before upload. This module stores the file data temporarily until the user
* accepts or declines, or until the TTL expires.
*/
const pendingUploads = /* @__PURE__ */ new Map();
/** TTL for pending uploads: 5 minutes */
const PENDING_UPLOAD_TTL_MS = 300 * 1e3;
/**
* Store a file pending user consent.
* Returns the upload ID to include in the FileConsentCard context.
*/
function storePendingUpload(upload) {
	const id = crypto.randomUUID();
	const entry = {
		...upload,
		id,
		createdAt: Date.now()
	};
	pendingUploads.set(id, entry);
	setTimeout(() => {
		pendingUploads.delete(id);
	}, PENDING_UPLOAD_TTL_MS);
	return id;
}
/**
* Retrieve a pending upload by ID.
* Returns undefined if not found or expired.
*/
function getPendingUpload(id) {
	if (!id) return;
	const entry = pendingUploads.get(id);
	if (!entry) return;
	if (Date.now() - entry.createdAt > PENDING_UPLOAD_TTL_MS) {
		pendingUploads.delete(id);
		return;
	}
	return entry;
}
/**
* Remove a pending upload (after successful upload or user decline).
*/
function removePendingUpload(id) {
	if (id) pendingUploads.delete(id);
}
//#endregion
//#region extensions/msteams/src/file-consent-helpers.ts
/**
* Shared helpers for FileConsentCard flow in MSTeams.
*
* FileConsentCard is required for:
* - Personal (1:1) chats with large files (>=4MB)
* - Personal chats with non-image files (PDFs, documents, etc.)
*
* This module consolidates the logic used by both send.ts (proactive sends)
* and messenger.ts (reply path) to avoid duplication.
*/
/**
* Prepare a FileConsentCard activity for large files or non-images in personal chats.
* Returns the activity object and uploadId - caller is responsible for sending.
*/
function prepareFileConsentActivity(params) {
	const { media, conversationId, description } = params;
	const uploadId = storePendingUpload({
		buffer: media.buffer,
		filename: media.filename,
		contentType: media.contentType,
		conversationId
	});
	return {
		activity: {
			type: "message",
			attachments: [buildFileConsentCard({
				filename: media.filename,
				description: description || `File: ${media.filename}`,
				sizeInBytes: media.buffer.length,
				context: { uploadId }
			})]
		},
		uploadId
	};
}
/**
* Check if a file requires FileConsentCard flow.
* True for: personal chat AND (large file OR non-image)
*/
function requiresFileConsent(params) {
	const isPersonal = params.conversationType?.toLowerCase() === "personal";
	const isImage = params.contentType?.startsWith("image/") ?? false;
	const isLargeFile = params.bufferSize >= params.thresholdBytes;
	return isPersonal && (isLargeFile || !isImage);
}
//#endregion
//#region extensions/msteams/src/graph-chat.ts
/**
* Build a native Teams file card attachment for Bot Framework.
*
* This uses the `application/vnd.microsoft.teams.card.file.info` content type
* which is supported by Bot Framework and produces native Teams file cards
* (the same display as when a user manually shares a file).
*
* @param file - DriveItem properties from getDriveItemProperties()
* @returns Attachment object for Bot Framework sendActivity()
*/
function buildTeamsFileInfoCard(file) {
	const rawETag = file.eTag;
	const uniqueId = rawETag.replace(/^["']|["']$/g, "").replace(/[{}]/g, "").split(",")[0] ?? rawETag;
	const lastDot = file.name.lastIndexOf(".");
	const fileType = lastDot >= 0 ? file.name.slice(lastDot + 1).toLowerCase() : "";
	return {
		contentType: "application/vnd.microsoft.teams.card.file.info",
		contentUrl: file.webDavUrl,
		name: file.name,
		content: {
			uniqueId,
			fileType
		}
	};
}
//#endregion
//#region extensions/msteams/src/graph-upload.ts
const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";
const GRAPH_BETA = "https://graph.microsoft.com/beta";
const GRAPH_SCOPE = "https://graph.microsoft.com";
function parseUploadedDriveItem(data, label) {
	if (!data.id || !data.webUrl || !data.name) throw new Error(`${label} upload response missing required fields`);
	return {
		id: data.id,
		webUrl: data.webUrl,
		name: data.name
	};
}
async function uploadDriveItem(params) {
	const fetchFn = params.fetchFn ?? fetch;
	const token = await params.tokenProvider.getAccessToken(GRAPH_SCOPE);
	const res = await fetchFn(params.url, {
		method: "PUT",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": params.contentType ?? "application/octet-stream"
		},
		body: new Uint8Array(params.buffer)
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`${params.label} upload failed: ${res.status} ${res.statusText} - ${body}`);
	}
	return parseUploadedDriveItem(await res.json(), params.label);
}
/**
* Upload a file to the user's OneDrive root folder.
* For larger files, this uses the simple upload endpoint (up to 4MB).
*/
async function uploadToOneDrive(params) {
	const uploadPath = `/OpenClawShared/${encodeURIComponent(params.filename)}`;
	return await uploadDriveItem({
		...params,
		url: `${GRAPH_ROOT}/me/drive/root:${uploadPath}:/content`,
		label: "OneDrive"
	});
}
/**
* Create a sharing link for a OneDrive file.
* The link allows organization members to view the file.
*/
async function createSharingLink(params) {
	const fetchFn = params.fetchFn ?? fetch;
	const token = await params.tokenProvider.getAccessToken(GRAPH_SCOPE);
	const res = await fetchFn(`${GRAPH_ROOT}/me/drive/items/${params.itemId}/createLink`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json"
		},
		body: JSON.stringify({
			type: "view",
			scope: params.scope ?? "organization"
		})
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`Create sharing link failed: ${res.status} ${res.statusText} - ${body}`);
	}
	const data = await res.json();
	if (!data.link?.webUrl) throw new Error("Create sharing link response missing webUrl");
	return { webUrl: data.link.webUrl };
}
/**
* Upload a file to OneDrive and create a sharing link.
* Convenience function for the common case.
*/
async function uploadAndShareOneDrive(params) {
	const uploaded = await uploadToOneDrive({
		buffer: params.buffer,
		filename: params.filename,
		contentType: params.contentType,
		tokenProvider: params.tokenProvider,
		fetchFn: params.fetchFn
	});
	const shareLink = await createSharingLink({
		itemId: uploaded.id,
		tokenProvider: params.tokenProvider,
		scope: params.scope,
		fetchFn: params.fetchFn
	});
	return {
		itemId: uploaded.id,
		webUrl: uploaded.webUrl,
		shareUrl: shareLink.webUrl,
		name: uploaded.name
	};
}
/**
* Upload a file to a SharePoint site.
* This is used for group chats and channels where /me/drive doesn't work for bots.
*
* @param params.siteId - SharePoint site ID (e.g., "contoso.sharepoint.com,guid1,guid2")
*/
async function uploadToSharePoint(params) {
	const uploadPath = `/OpenClawShared/${encodeURIComponent(params.filename)}`;
	return await uploadDriveItem({
		...params,
		url: `${GRAPH_ROOT}/sites/${params.siteId}/drive/root:${uploadPath}:/content`,
		label: "SharePoint"
	});
}
/**
* Get driveItem properties needed for native Teams file card attachments.
* This fetches the eTag and webDavUrl which are required for "reference" type attachments.
*
* @param params.siteId - SharePoint site ID
* @param params.itemId - The driveItem ID (returned from upload)
*/
async function getDriveItemProperties(params) {
	const fetchFn = params.fetchFn ?? fetch;
	const token = await params.tokenProvider.getAccessToken(GRAPH_SCOPE);
	const res = await fetchFn(`${GRAPH_ROOT}/sites/${params.siteId}/drive/items/${params.itemId}?$select=eTag,webDavUrl,name`, { headers: { Authorization: `Bearer ${token}` } });
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`Get driveItem properties failed: ${res.status} ${res.statusText} - ${body}`);
	}
	const data = await res.json();
	if (!data.eTag || !data.webDavUrl || !data.name) throw new Error("DriveItem response missing required properties (eTag, webDavUrl, or name)");
	return {
		eTag: data.eTag,
		webDavUrl: data.webDavUrl,
		name: data.name
	};
}
/**
* Get members of a Teams chat for per-user sharing.
* Used to create sharing links scoped to only the chat participants.
*/
async function getChatMembers(params) {
	const fetchFn = params.fetchFn ?? fetch;
	const token = await params.tokenProvider.getAccessToken(GRAPH_SCOPE);
	const res = await fetchFn(`${GRAPH_ROOT}/chats/${params.chatId}/members`, { headers: { Authorization: `Bearer ${token}` } });
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`Get chat members failed: ${res.status} ${res.statusText} - ${body}`);
	}
	return ((await res.json()).value ?? []).map((m) => ({
		aadObjectId: m.userId ?? "",
		displayName: m.displayName
	})).filter((m) => m.aadObjectId);
}
/**
* Create a sharing link for a SharePoint drive item.
* For organization scope (default), uses v1.0 API.
* For per-user scope, uses beta API with recipients.
*/
async function createSharePointSharingLink(params) {
	const fetchFn = params.fetchFn ?? fetch;
	const token = await params.tokenProvider.getAccessToken(GRAPH_SCOPE);
	const scope = params.scope ?? "organization";
	const apiRoot = scope === "users" ? GRAPH_BETA : GRAPH_ROOT;
	const body = {
		type: "view",
		scope: scope === "users" ? "users" : "organization"
	};
	if (scope === "users" && params.recipientObjectIds?.length) body.recipients = params.recipientObjectIds.map((id) => ({ objectId: id }));
	const res = await fetchFn(`${apiRoot}/sites/${params.siteId}/drive/items/${params.itemId}/createLink`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json"
		},
		body: JSON.stringify(body)
	});
	if (!res.ok) {
		const respBody = await res.text().catch(() => "");
		throw new Error(`Create SharePoint sharing link failed: ${res.status} ${res.statusText} - ${respBody}`);
	}
	const data = await res.json();
	if (!data.link?.webUrl) throw new Error("Create SharePoint sharing link response missing webUrl");
	return { webUrl: data.link.webUrl };
}
/**
* Upload a file to SharePoint and create a sharing link.
*
* For group chats, this creates a per-user sharing link scoped to chat members.
* For channels, this creates an organization-wide sharing link.
*
* @param params.siteId - SharePoint site ID
* @param params.chatId - Optional chat ID for per-user sharing (group chats)
* @param params.usePerUserSharing - Whether to use per-user sharing (requires beta API + Chat.Read.All)
*/
async function uploadAndShareSharePoint(params) {
	const uploaded = await uploadToSharePoint({
		buffer: params.buffer,
		filename: params.filename,
		contentType: params.contentType,
		tokenProvider: params.tokenProvider,
		siteId: params.siteId,
		fetchFn: params.fetchFn
	});
	let scope = "organization";
	let recipientObjectIds;
	if (params.usePerUserSharing && params.chatId) try {
		const members = await getChatMembers({
			chatId: params.chatId,
			tokenProvider: params.tokenProvider,
			fetchFn: params.fetchFn
		});
		if (members.length > 0) {
			scope = "users";
			recipientObjectIds = members.map((m) => m.aadObjectId);
		}
	} catch {}
	const shareLink = await createSharePointSharingLink({
		siteId: params.siteId,
		itemId: uploaded.id,
		tokenProvider: params.tokenProvider,
		scope,
		recipientObjectIds,
		fetchFn: params.fetchFn
	});
	return {
		itemId: uploaded.id,
		webUrl: uploaded.webUrl,
		shareUrl: shareLink.webUrl,
		name: uploaded.name
	};
}
//#endregion
//#region extensions/msteams/src/media-helpers.ts
/**
* MIME type detection and filename extraction for MSTeams media attachments.
*/
/**
* Detect MIME type from URL extension or data URL.
* Uses shared MIME detection for consistency with core handling.
*/
async function getMimeType(url) {
	if (url.startsWith("data:")) {
		const match = url.match(/^data:([^;,]+)/);
		if (match?.[1]) return match[1];
	}
	return await detectMime({ filePath: url }) ?? "application/octet-stream";
}
/**
* Extract filename from URL or local path.
* For local paths, extracts original filename if stored with embedded name pattern.
* Falls back to deriving the extension from MIME type when no extension present.
*/
async function extractFilename(url) {
	if (url.startsWith("data:")) {
		const mime = await getMimeType(url);
		const ext = extensionForMime(mime) ?? ".bin";
		return `${mime.startsWith("image/") ? "image" : "file"}${ext}`;
	}
	try {
		const pathname = new URL(url).pathname;
		const basename = path.basename(pathname);
		const existingExt = getFileExtension(pathname);
		if (basename && existingExt) return basename;
		const mime = await getMimeType(url);
		const ext = extensionForMime(mime) ?? ".bin";
		const prefix = mime.startsWith("image/") ? "image" : "file";
		return basename ? `${basename}${ext}` : `${prefix}${ext}`;
	} catch {
		return extractOriginalFilename(url);
	}
}
/**
* Check if a URL refers to a local file path.
*/
function isLocalPath(url) {
	if (url.startsWith("file://") || url.startsWith("/") || url.startsWith("~")) return true;
	if (url.startsWith("\\") && !url.startsWith("\\\\")) return true;
	if (/^[a-zA-Z]:[\\/]/.test(url)) return true;
	if (url.startsWith("\\\\")) return true;
	return false;
}
/**
* Extract the message ID from a Bot Framework response.
*/
function extractMessageId(response) {
	if (!response || typeof response !== "object") return null;
	if (!("id" in response)) return null;
	const { id } = response;
	if (typeof id !== "string" || !id) return null;
	return id;
}
//#endregion
//#region extensions/msteams/src/mentions.ts
/**
* Check whether an ID looks like a valid Teams user/bot identifier.
* Accepts:
* - Bot Framework IDs: "28:xxx..." / "29:xxx..." / "8:orgid:..."
* - AAD object IDs (UUIDs): "d5318c29-33ac-4e6b-bd42-57b8b793908f"
*
* Keep this permissive enough for real Teams IDs while still rejecting
* documentation placeholders like `@[表示名](ユーザーID)`.
*/
const TEAMS_BOT_ID_PATTERN = /^\d+:[a-z0-9._=-]+(?::[a-z0-9._=-]+)*$/i;
const AAD_OBJECT_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function isValidTeamsId(id) {
	return TEAMS_BOT_ID_PATTERN.test(id) || AAD_OBJECT_ID_PATTERN.test(id);
}
/**
* Parse mentions from text in the format @[Name](id).
* Example: "Hello @[John Doe](28:xxx-yyy-zzz)!"
*
* Only matches where the id looks like a real Teams user/bot ID are treated
* as mentions. This avoids false positives from documentation or code samples
* embedded in the message (e.g. `@[表示名](ユーザーID)` in backticks).
*
* Returns both the formatted text with <at> tags and the entities array.
*/
function parseMentions(text) {
	const mentionPattern = /@\[([^\]]+)\]\(([^)]+)\)/g;
	const entities = [];
	return {
		text: text.replace(mentionPattern, (match, name, id) => {
			const trimmedId = id.trim();
			if (!isValidTeamsId(trimmedId)) return match;
			const trimmedName = name.trim();
			const mentionTag = `<at>${trimmedName}</at>`;
			entities.push({
				type: "mention",
				text: mentionTag,
				mentioned: {
					id: trimmedId,
					name: trimmedName
				}
			});
			return mentionTag;
		}),
		entities
	};
}
//#endregion
//#region extensions/msteams/src/revoked-context.ts
async function withRevokedProxyFallback(params) {
	try {
		return await params.run();
	} catch (err) {
		if (!isRevokedProxyError(err)) throw err;
		params.onRevokedLog?.();
		return await params.onRevoked();
	}
}
//#endregion
//#region extensions/msteams/src/messenger.ts
/**
* MSTeams-specific media size limit (100MB).
* Higher than the default because OneDrive upload handles large files well.
*/
const MSTEAMS_MAX_MEDIA_BYTES$1 = 100 * 1024 * 1024;
/**
* Threshold for large files that require FileConsentCard flow in personal chats.
* Files >= 4MB use consent flow; smaller images can use inline base64.
*/
const FILE_CONSENT_THRESHOLD_BYTES$1 = 4 * 1024 * 1024;
function normalizeConversationId(rawId) {
	return rawId.split(";")[0] ?? rawId;
}
function buildConversationReference(ref) {
	const conversationId = ref.conversation?.id?.trim();
	if (!conversationId) throw new Error("Invalid stored reference: missing conversation.id");
	const agent = ref.agent ?? ref.bot ?? void 0;
	if (agent == null || !agent.id) throw new Error("Invalid stored reference: missing agent.id");
	const user = ref.user;
	if (!user?.id) throw new Error("Invalid stored reference: missing user.id");
	return {
		activityId: ref.activityId,
		user,
		agent,
		conversation: {
			id: normalizeConversationId(conversationId),
			conversationType: ref.conversation?.conversationType,
			tenantId: ref.conversation?.tenantId
		},
		channelId: ref.channelId ?? "msteams",
		serviceUrl: ref.serviceUrl,
		locale: ref.locale
	};
}
function pushTextMessages(out, text, opts) {
	if (!text) return;
	if (opts.chunkText) {
		for (const chunk of getMSTeamsRuntime().channel.text.chunkMarkdownTextWithMode(text, opts.chunkLimit, opts.chunkMode)) {
			const trimmed = chunk.trim();
			if (!trimmed || isSilentReplyText(trimmed, "NO_REPLY")) continue;
			out.push({ text: trimmed });
		}
		return;
	}
	const trimmed = text.trim();
	if (!trimmed || isSilentReplyText(trimmed, "NO_REPLY")) return;
	out.push({ text: trimmed });
}
function clampMs(value, maxMs) {
	if (!Number.isFinite(value) || value < 0) return 0;
	return Math.min(value, maxMs);
}
function resolveRetryOptions(retry) {
	if (!retry) return {
		enabled: false,
		maxAttempts: 1,
		baseDelayMs: 0,
		maxDelayMs: 0
	};
	return {
		enabled: true,
		maxAttempts: Math.max(1, retry?.maxAttempts ?? 3),
		baseDelayMs: Math.max(0, retry?.baseDelayMs ?? 250),
		maxDelayMs: Math.max(0, retry?.maxDelayMs ?? 1e4)
	};
}
function computeRetryDelayMs(attempt, classification, opts) {
	if (classification.retryAfterMs != null) return clampMs(classification.retryAfterMs, opts.maxDelayMs);
	return clampMs(opts.baseDelayMs * 2 ** Math.max(0, attempt - 1), opts.maxDelayMs);
}
function shouldRetry(classification) {
	return classification.kind === "throttled" || classification.kind === "transient";
}
function renderReplyPayloadsToMessages(replies, options) {
	const out = [];
	const chunkLimit = Math.min(options.textChunkLimit, 4e3);
	const chunkText = options.chunkText !== false;
	const chunkMode = options.chunkMode ?? "length";
	const mediaMode = options.mediaMode ?? "split";
	const tableMode = options.tableMode ?? getMSTeamsRuntime().channel.text.resolveMarkdownTableMode({
		cfg: getMSTeamsRuntime().config.loadConfig(),
		channel: "msteams"
	});
	for (const payload of replies) {
		const mediaList = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
		const text = getMSTeamsRuntime().channel.text.convertMarkdownTables(payload.text ?? "", tableMode);
		if (!text && mediaList.length === 0) continue;
		if (mediaList.length === 0) {
			pushTextMessages(out, text, {
				chunkText,
				chunkLimit,
				chunkMode
			});
			continue;
		}
		if (mediaMode === "inline") {
			const firstMedia = mediaList[0];
			if (firstMedia) {
				out.push({
					text: text || void 0,
					mediaUrl: firstMedia
				});
				for (let i = 1; i < mediaList.length; i++) if (mediaList[i]) out.push({ mediaUrl: mediaList[i] });
			} else pushTextMessages(out, text, {
				chunkText,
				chunkLimit,
				chunkMode
			});
			continue;
		}
		pushTextMessages(out, text, {
			chunkText,
			chunkLimit,
			chunkMode
		});
		for (const mediaUrl of mediaList) {
			if (!mediaUrl) continue;
			out.push({ mediaUrl });
		}
	}
	return out;
}
async function buildActivity(msg, conversationRef, tokenProvider, sharePointSiteId, mediaMaxBytes) {
	const activity = { type: "message" };
	if (msg.text) {
		const { text: formattedText, entities } = parseMentions(msg.text);
		activity.text = formattedText;
		if (entities.length > 0) activity.entities = entities;
	}
	if (msg.mediaUrl) {
		let contentUrl = msg.mediaUrl;
		let contentType = await getMimeType(msg.mediaUrl);
		let fileName = await extractFilename(msg.mediaUrl);
		if (isLocalPath(msg.mediaUrl)) {
			const maxBytes = mediaMaxBytes ?? MSTEAMS_MAX_MEDIA_BYTES$1;
			const media = await loadWebMedia(msg.mediaUrl, maxBytes);
			contentType = media.contentType ?? contentType;
			fileName = media.fileName ?? fileName;
			const conversationType = conversationRef.conversation?.conversationType?.toLowerCase();
			const isPersonal = conversationType === "personal";
			const isImage = media.kind === "image";
			if (requiresFileConsent({
				conversationType,
				contentType,
				bufferSize: media.buffer.length,
				thresholdBytes: FILE_CONSENT_THRESHOLD_BYTES$1
			})) {
				const conversationId = conversationRef.conversation?.id ?? "unknown";
				const { activity: consentActivity } = prepareFileConsentActivity({
					media: {
						buffer: media.buffer,
						filename: fileName,
						contentType
					},
					conversationId,
					description: msg.text || void 0
				});
				return consentActivity;
			}
			if (!isPersonal && !isImage && tokenProvider && sharePointSiteId) {
				const chatId = conversationRef.conversation?.id;
				activity.attachments = [buildTeamsFileInfoCard(await getDriveItemProperties({
					siteId: sharePointSiteId,
					itemId: (await uploadAndShareSharePoint({
						buffer: media.buffer,
						filename: fileName,
						contentType,
						tokenProvider,
						siteId: sharePointSiteId,
						chatId: chatId ?? void 0,
						usePerUserSharing: conversationType === "groupchat"
					})).itemId,
					tokenProvider
				}))];
				return activity;
			}
			if (!isPersonal && media.kind !== "image" && tokenProvider) {
				const uploaded = await uploadAndShareOneDrive({
					buffer: media.buffer,
					filename: fileName,
					contentType,
					tokenProvider
				});
				const fileLink = `📎 [${uploaded.name}](${uploaded.shareUrl})`;
				const existingText = typeof activity.text === "string" ? activity.text : void 0;
				activity.text = existingText ? `${existingText}\n\n${fileLink}` : fileLink;
				return activity;
			}
			const base64 = media.buffer.toString("base64");
			contentUrl = `data:${media.contentType};base64,${base64}`;
		}
		activity.attachments = [{
			name: fileName,
			contentType,
			contentUrl
		}];
	}
	return activity;
}
async function sendMSTeamsMessages(params) {
	const messages = params.messages.filter((m) => m.text && m.text.trim().length > 0 || m.mediaUrl);
	if (messages.length === 0) return [];
	const retryOptions = resolveRetryOptions(params.retry);
	const sendWithRetry = async (sendOnce, meta) => {
		if (!retryOptions.enabled) return await sendOnce();
		let attempt = 1;
		while (true) try {
			return await sendOnce();
		} catch (err) {
			const classification = classifyMSTeamsSendError(err);
			if (!(attempt < retryOptions.maxAttempts && shouldRetry(classification))) throw err;
			const delayMs = computeRetryDelayMs(attempt, classification, retryOptions);
			const nextAttempt = attempt + 1;
			params.onRetry?.({
				messageIndex: meta.messageIndex,
				messageCount: meta.messageCount,
				nextAttempt,
				maxAttempts: retryOptions.maxAttempts,
				delayMs,
				classification
			});
			await sleep(delayMs);
			attempt = nextAttempt;
		}
	};
	const sendMessageInContext = async (ctx, message, messageIndex) => {
		return extractMessageId(await sendWithRetry(async () => await ctx.sendActivity(await buildActivity(message, params.conversationRef, params.tokenProvider, params.sharePointSiteId, params.mediaMaxBytes)), {
			messageIndex,
			messageCount: messages.length
		})) ?? "unknown";
	};
	const sendMessageBatchInContext = async (ctx, batch, startIndex) => {
		const messageIds = [];
		for (const [idx, message] of batch.entries()) messageIds.push(await sendMessageInContext(ctx, message, startIndex + idx));
		return messageIds;
	};
	const sendProactively = async (batch, startIndex) => {
		const proactiveRef = {
			...buildConversationReference(params.conversationRef),
			activityId: void 0
		};
		const messageIds = [];
		await params.adapter.continueConversation(params.appId, proactiveRef, async (ctx) => {
			messageIds.push(...await sendMessageBatchInContext(ctx, batch, startIndex));
		});
		return messageIds;
	};
	if (params.replyStyle === "thread") {
		const ctx = params.context;
		if (!ctx) throw new Error("Missing context for replyStyle=thread");
		const messageIds = [];
		for (const [idx, message] of messages.entries()) {
			const result = await withRevokedProxyFallback({
				run: async () => ({
					ids: [await sendMessageInContext(ctx, message, idx)],
					fellBack: false
				}),
				onRevoked: async () => {
					const remaining = messages.slice(idx);
					return {
						ids: remaining.length > 0 ? await sendProactively(remaining, idx) : [],
						fellBack: true
					};
				}
			});
			messageIds.push(...result.ids);
			if (result.fellBack) return messageIds;
		}
		return messageIds;
	}
	return await sendProactively(messages, 0);
}
//#endregion
//#region extensions/msteams/src/send-context.ts
/**
* Parse the target value into a conversation reference lookup key.
* Supported formats:
* - conversation:19:abc@thread.tacv2 → lookup by conversation ID
* - user:aad-object-id → lookup by user AAD object ID
* - 19:abc@thread.tacv2 → direct conversation ID
*/
function parseRecipient(to) {
	const trimmed = to.trim();
	const finalize = (type, id) => {
		const normalized = id.trim();
		if (!normalized) throw new Error(`Invalid target value: missing ${type} id`);
		return {
			type,
			id: normalized
		};
	};
	if (trimmed.startsWith("conversation:")) return finalize("conversation", trimmed.slice(13));
	if (trimmed.startsWith("user:")) return finalize("user", trimmed.slice(5));
	if (trimmed.startsWith("19:") || trimmed.includes("@thread")) return finalize("conversation", trimmed);
	return finalize("user", trimmed);
}
/**
* Find a stored conversation reference for the given recipient.
*/
async function findConversationReference(recipient) {
	if (recipient.type === "conversation") {
		const ref = await recipient.store.get(recipient.id);
		if (ref) return {
			conversationId: recipient.id,
			ref
		};
		return null;
	}
	const found = await recipient.store.findByUserId(recipient.id);
	if (!found) return null;
	return {
		conversationId: found.conversationId,
		ref: found.reference
	};
}
async function resolveMSTeamsSendContext(params) {
	const msteamsCfg = params.cfg.channels?.msteams;
	if (!msteamsCfg?.enabled) throw new Error("msteams provider is not enabled");
	const creds = resolveMSTeamsCredentials(msteamsCfg);
	if (!creds) throw new Error("msteams credentials not configured");
	const store = createMSTeamsConversationStoreFs();
	const recipient = parseRecipient(params.to);
	const found = await findConversationReference({
		...recipient,
		store
	});
	if (!found) throw new Error(`No conversation reference found for ${recipient.type}:${recipient.id}. The bot must receive a message from this conversation before it can send proactively.`);
	const { conversationId, ref } = found;
	const log = getMSTeamsRuntime().logging.getChildLogger({ name: "msteams:send" });
	const { sdk, authConfig } = await loadMSTeamsSdkWithAuth(creds);
	const adapter = createMSTeamsAdapter(authConfig, sdk);
	const tokenProvider = new sdk.MsalTokenProvider(authConfig);
	const storedConversationType = ref.conversation?.conversationType?.toLowerCase() ?? "";
	let conversationType;
	if (storedConversationType === "personal") conversationType = "personal";
	else if (storedConversationType === "channel") conversationType = "channel";
	else conversationType = "groupChat";
	const sharePointSiteId = msteamsCfg.sharePointSiteId;
	const mediaMaxBytes = resolveChannelMediaMaxBytes({
		cfg: params.cfg,
		resolveChannelLimitMb: ({ cfg }) => cfg.channels?.msteams?.mediaMaxMb
	});
	return {
		appId: creds.appId,
		conversationId,
		ref,
		adapter,
		log,
		conversationType,
		tokenProvider,
		sharePointSiteId,
		mediaMaxBytes
	};
}
//#endregion
//#region extensions/msteams/src/send.ts
/** Threshold for large files that require FileConsentCard flow in personal chats */
const FILE_CONSENT_THRESHOLD_BYTES = 4 * 1024 * 1024;
/**
* MSTeams-specific media size limit (100MB).
* Higher than the default because OneDrive upload handles large files well.
*/
const MSTEAMS_MAX_MEDIA_BYTES = 100 * 1024 * 1024;
/**
* Send a message to a Teams conversation or user.
*
* Uses the stored ConversationReference from previous interactions.
* The bot must have received at least one message from the conversation
* before proactive messaging works.
*
* File handling by conversation type:
* - Personal (1:1) chats: small images (<4MB) use base64, large files and non-images use FileConsentCard
* - Group chats / channels: files are uploaded to OneDrive and shared via link
*/
async function sendMessageMSTeams(params) {
	const { cfg, to, text, mediaUrl, mediaLocalRoots } = params;
	const tableMode = getMSTeamsRuntime().channel.text.resolveMarkdownTableMode({
		cfg,
		channel: "msteams"
	});
	const messageText = getMSTeamsRuntime().channel.text.convertMarkdownTables(text ?? "", tableMode);
	const ctx = await resolveMSTeamsSendContext({
		cfg,
		to
	});
	const { adapter, appId, conversationId, ref, log, conversationType, tokenProvider, sharePointSiteId } = ctx;
	log.debug?.("sending proactive message", {
		conversationId,
		conversationType,
		textLength: messageText.length,
		hasMedia: Boolean(mediaUrl)
	});
	if (mediaUrl) {
		const media = await loadOutboundMediaFromUrl(mediaUrl, {
			maxBytes: ctx.mediaMaxBytes ?? MSTEAMS_MAX_MEDIA_BYTES,
			mediaLocalRoots
		});
		const isLargeFile = media.buffer.length >= FILE_CONSENT_THRESHOLD_BYTES;
		const isImage = media.contentType?.startsWith("image/") ?? false;
		const fallbackFileName = await extractFilename(mediaUrl);
		const fileName = media.fileName ?? fallbackFileName;
		log.debug?.("processing media", {
			fileName,
			contentType: media.contentType,
			size: media.buffer.length,
			isLargeFile,
			isImage,
			conversationType
		});
		if (requiresFileConsent({
			conversationType,
			contentType: media.contentType,
			bufferSize: media.buffer.length,
			thresholdBytes: FILE_CONSENT_THRESHOLD_BYTES
		})) {
			const { activity, uploadId } = prepareFileConsentActivity({
				media: {
					buffer: media.buffer,
					filename: fileName,
					contentType: media.contentType
				},
				conversationId,
				description: messageText || void 0
			});
			log.debug?.("sending file consent card", {
				uploadId,
				fileName,
				size: media.buffer.length
			});
			const messageId = await sendProactiveActivity({
				adapter,
				appId,
				ref,
				activity,
				errorPrefix: "msteams consent card send"
			});
			log.info("sent file consent card", {
				conversationId,
				messageId,
				uploadId
			});
			return {
				messageId,
				conversationId,
				pendingUploadId: uploadId
			};
		}
		if (conversationType === "personal") {
			const base64 = media.buffer.toString("base64");
			return sendTextWithMedia(ctx, messageText, `data:${media.contentType};base64,${base64}`);
		}
		if (isImage && !sharePointSiteId) {
			const base64 = media.buffer.toString("base64");
			return sendTextWithMedia(ctx, messageText, `data:${media.contentType};base64,${base64}`);
		}
		try {
			if (sharePointSiteId) {
				log.debug?.("uploading to SharePoint for native file card", {
					fileName,
					conversationType,
					siteId: sharePointSiteId
				});
				const uploaded = await uploadAndShareSharePoint({
					buffer: media.buffer,
					filename: fileName,
					contentType: media.contentType,
					tokenProvider,
					siteId: sharePointSiteId,
					chatId: conversationId,
					usePerUserSharing: conversationType === "groupChat"
				});
				log.debug?.("SharePoint upload complete", {
					itemId: uploaded.itemId,
					shareUrl: uploaded.shareUrl
				});
				const driveItem = await getDriveItemProperties({
					siteId: sharePointSiteId,
					itemId: uploaded.itemId,
					tokenProvider
				});
				log.debug?.("driveItem properties retrieved", {
					eTag: driveItem.eTag,
					webDavUrl: driveItem.webDavUrl
				});
				const fileCardAttachment = buildTeamsFileInfoCard(driveItem);
				const messageId = await sendProactiveActivityRaw({
					adapter,
					appId,
					ref,
					activity: {
						type: "message",
						text: messageText || void 0,
						attachments: [fileCardAttachment]
					}
				});
				log.info("sent native file card", {
					conversationId,
					messageId,
					fileName: driveItem.name
				});
				return {
					messageId,
					conversationId
				};
			}
			log.debug?.("uploading to OneDrive (no SharePoint site configured)", {
				fileName,
				conversationType
			});
			const uploaded = await uploadAndShareOneDrive({
				buffer: media.buffer,
				filename: fileName,
				contentType: media.contentType,
				tokenProvider
			});
			log.debug?.("OneDrive upload complete", {
				itemId: uploaded.itemId,
				shareUrl: uploaded.shareUrl
			});
			const fileLink = `📎 [${uploaded.name}](${uploaded.shareUrl})`;
			const messageId = await sendProactiveActivityRaw({
				adapter,
				appId,
				ref,
				activity: {
					type: "message",
					text: messageText ? `${messageText}\n\n${fileLink}` : fileLink
				}
			});
			log.info("sent message with OneDrive file link", {
				conversationId,
				messageId,
				shareUrl: uploaded.shareUrl
			});
			return {
				messageId,
				conversationId
			};
		} catch (err) {
			const classification = classifyMSTeamsSendError(err);
			const hint = formatMSTeamsSendErrorHint(classification);
			const status = classification.statusCode ? ` (HTTP ${classification.statusCode})` : "";
			throw new Error(`msteams file send failed${status}: ${formatUnknownError(err)}${hint ? ` (${hint})` : ""}`, { cause: err });
		}
	}
	return sendTextWithMedia(ctx, messageText, void 0);
}
/**
* Send a text message with optional base64 media URL.
*/
async function sendTextWithMedia(ctx, text, mediaUrl) {
	const { adapter, appId, conversationId, ref, log, tokenProvider, sharePointSiteId, mediaMaxBytes } = ctx;
	let messageIds;
	try {
		messageIds = await sendMSTeamsMessages({
			replyStyle: "top-level",
			adapter,
			appId,
			conversationRef: ref,
			messages: [{
				text: text || void 0,
				mediaUrl
			}],
			retry: {},
			onRetry: (event) => {
				log.debug?.("retrying send", {
					conversationId,
					...event
				});
			},
			tokenProvider,
			sharePointSiteId,
			mediaMaxBytes
		});
	} catch (err) {
		const classification = classifyMSTeamsSendError(err);
		const hint = formatMSTeamsSendErrorHint(classification);
		const status = classification.statusCode ? ` (HTTP ${classification.statusCode})` : "";
		throw new Error(`msteams send failed${status}: ${formatUnknownError(err)}${hint ? ` (${hint})` : ""}`, { cause: err });
	}
	const messageId = messageIds[0] ?? "unknown";
	log.info("sent proactive message", {
		conversationId,
		messageId
	});
	return {
		messageId,
		conversationId
	};
}
async function sendProactiveActivityRaw({ adapter, appId, ref, activity }) {
	const proactiveRef = {
		...buildConversationReference(ref),
		activityId: void 0
	};
	let messageId = "unknown";
	await adapter.continueConversation(appId, proactiveRef, async (ctx) => {
		messageId = extractMessageId(await ctx.sendActivity(activity)) ?? "unknown";
	});
	return messageId;
}
async function sendProactiveActivity({ adapter, appId, ref, activity, errorPrefix }) {
	try {
		return await sendProactiveActivityRaw({
			adapter,
			appId,
			ref,
			activity
		});
	} catch (err) {
		const classification = classifyMSTeamsSendError(err);
		const hint = formatMSTeamsSendErrorHint(classification);
		const status = classification.statusCode ? ` (HTTP ${classification.statusCode})` : "";
		throw new Error(`${errorPrefix} failed${status}: ${formatUnknownError(err)}${hint ? ` (${hint})` : ""}`, { cause: err });
	}
}
/**
* Send a poll (Adaptive Card) to a Teams conversation or user.
*/
async function sendPollMSTeams(params) {
	const { cfg, to, question, options, maxSelections } = params;
	const { adapter, appId, conversationId, ref, log } = await resolveMSTeamsSendContext({
		cfg,
		to
	});
	const pollCard = buildMSTeamsPollCard({
		question,
		options,
		maxSelections
	});
	log.debug?.("sending poll", {
		conversationId,
		pollId: pollCard.pollId,
		optionCount: pollCard.options.length
	});
	const messageId = await sendProactiveActivity({
		adapter,
		appId,
		ref,
		activity: {
			type: "message",
			attachments: [{
				contentType: "application/vnd.microsoft.card.adaptive",
				content: pollCard.card
			}]
		},
		errorPrefix: "msteams poll send"
	});
	log.info("sent poll", {
		conversationId,
		pollId: pollCard.pollId,
		messageId
	});
	return {
		pollId: pollCard.pollId,
		messageId,
		conversationId
	};
}
/**
* Send an arbitrary Adaptive Card to a Teams conversation or user.
*/
async function sendAdaptiveCardMSTeams(params) {
	const { cfg, to, card } = params;
	const { adapter, appId, conversationId, ref, log } = await resolveMSTeamsSendContext({
		cfg,
		to
	});
	log.debug?.("sending adaptive card", {
		conversationId,
		cardType: card.type,
		cardVersion: card.version
	});
	const messageId = await sendProactiveActivity({
		adapter,
		appId,
		ref,
		activity: {
			type: "message",
			attachments: [{
				contentType: "application/vnd.microsoft.card.adaptive",
				content: card
			}]
		},
		errorPrefix: "msteams card send"
	});
	log.info("sent adaptive card", {
		conversationId,
		messageId
	});
	return {
		messageId,
		conversationId
	};
}
//#endregion
//#region extensions/msteams/src/probe.ts
function decodeJwtPayload(token) {
	const parts = token.split(".");
	if (parts.length < 2) return null;
	const payload = parts[1] ?? "";
	const normalized = payload.padEnd(payload.length + (4 - payload.length % 4) % 4, "=").replace(/-/g, "+").replace(/_/g, "/");
	try {
		const decoded = Buffer.from(normalized, "base64").toString("utf8");
		const parsed = JSON.parse(decoded);
		return parsed && typeof parsed === "object" ? parsed : null;
	} catch {
		return null;
	}
}
function readStringArray(value) {
	if (!Array.isArray(value)) return;
	const out = normalizeStringEntries(value);
	return out.length > 0 ? out : void 0;
}
function readScopes(value) {
	if (typeof value !== "string") return;
	const out = value.split(/\s+/).map((entry) => entry.trim()).filter(Boolean);
	return out.length > 0 ? out : void 0;
}
async function probeMSTeams(cfg) {
	const creds = resolveMSTeamsCredentials(cfg);
	if (!creds) return {
		ok: false,
		error: "missing credentials (appId, appPassword, tenantId)"
	};
	try {
		const { sdk, authConfig } = await loadMSTeamsSdkWithAuth(creds);
		const tokenProvider = new sdk.MsalTokenProvider(authConfig);
		await tokenProvider.getAccessToken("https://api.botframework.com");
		let graph;
		try {
			const accessToken = readAccessToken(await tokenProvider.getAccessToken("https://graph.microsoft.com"));
			const payload = accessToken ? decodeJwtPayload(accessToken) : null;
			graph = {
				ok: true,
				roles: readStringArray(payload?.roles),
				scopes: readScopes(payload?.scp)
			};
		} catch (err) {
			graph = {
				ok: false,
				error: formatUnknownError(err)
			};
		}
		return {
			ok: true,
			appId: creds.appId,
			...graph ? { graph } : {}
		};
	} catch (err) {
		return {
			ok: false,
			appId: creds.appId,
			error: formatUnknownError(err)
		};
	}
}
//#endregion
export { createMSTeamsConversationStoreFs as _, buildConversationReference as a, withRevokedProxyFallback as c, buildFileInfoCard as d, parseFileConsentInvoke as f, formatUnknownError as g, formatMSTeamsSendErrorHint as h, sendPollMSTeams as i, getPendingUpload as l, classifyMSTeamsSendError as m, sendAdaptiveCardMSTeams as n, renderReplyPayloadsToMessages as o, uploadToConsentUrl as p, sendMessageMSTeams as r, sendMSTeamsMessages as s, probeMSTeams as t, removePendingUpload as u, createMSTeamsPollStoreFs as v, extractMSTeamsPollVote as y };
