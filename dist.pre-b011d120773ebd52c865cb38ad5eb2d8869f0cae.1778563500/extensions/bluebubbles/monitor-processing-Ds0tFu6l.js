import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, r as lowercasePreservingWhitespace, s as normalizeOptionalLowercaseString } from "../../string-coerce-Bje8XVt9.js";
import { v as resolveStateDir } from "../../paths-C1_Y0cDn.js";
import { d as normalizeSecretInputString } from "../../types.secrets-CL51SR4g.js";
import { n as resolvePreferredOpenClawTmpDir } from "../../tmp-openclaw-dir-DItE5Xhf.js";
import { r as logVerbose$1 } from "../../globals-BHVmraBM.js";
import { f as resolveOutboundMediaUrls, g as sendMediaWithLeadingCaption, h as resolveTextChunksWithFallback } from "../../reply-payload-4x-lSxGs.js";
import { a as safeFileURLToPath, n as basenameFromMediaSource } from "../../local-file-access-B5LBJss6.js";
import "../../temp-path-Cv3EKWOY.js";
import { m as mapAllowFromEntries } from "../../channel-config-helpers-D37zitas.js";
import { i as resolveAgentRoute } from "../../resolve-route-Cm8sGLH2.js";
import { t as resolveAckReaction } from "../../identity-D0LXZhU5.js";
import { r as stripMarkdown } from "../../text-runtime-FOsx_CPC.js";
import "../../routing-DfF4_bqH.js";
import { n as resolveControlCommandGate } from "../../command-gating-YKBQrdQs.js";
import { d as recordPendingHistoryEntryIfEnabled, l as evictOldHistoryKeys } from "../../history-BaFS7DlT.js";
import { t as evaluateSupplementalContextVisibility } from "../../context-visibility-DWLqPqkW.js";
import { t as createChannelReplyPipeline } from "../../channel-reply-pipeline-ChCtYK0Y.js";
import "../../channel-policy-BdLhwf7S.js";
import { n as readStoreAllowFromForDmPolicy, o as resolveDmGroupAccessWithLists, t as DM_GROUP_ACCESS_REASON } from "../../dm-policy-shared-CFD2FPpz.js";
import "../../reply-history-r3vT25Bx.js";
import { n as logInboundDrop, r as logTypingFailure, t as logAckFailure } from "../../logging-Dd0CeATB.js";
import { t as resolveChannelMediaMaxBytes } from "../../media-limits-DkpcBnqF.js";
import { n as createChannelPairingController } from "../../channel-pairing-DWcD6g9Y.js";
import "../../runtime-env-DyZrKYOx.js";
import { t as resolveChannelContextVisibilityMode } from "../../context-visibility-BDQvO5A4.js";
import "../../file-access-runtime-CC_MKeR6.js";
import { o as isPrivateNetworkOptInEnabled } from "../../ssrf-policy-DtOyW3pK.js";
import "../../ssrf-runtime-Cup62pw7.js";
import "../../media-runtime-Doi16sSJ.js";
import { n as resolveConfiguredBindingRoute, r as resolveRuntimeConversationBindingRoute } from "../../binding-routing-BFHEYlgS.js";
import "../../conversation-runtime-WRmNcyfY.js";
import "../../security-runtime-DiXnHkF3.js";
import "../../command-auth-oYbsjyAn.js";
import "../../channel-feedback-CJVY1O_2.js";
import "../../channel-inbound-CtPTvcjp.js";
import "../../string-coerce-runtime-DdUmJDgy.js";
import { t as createClaimableDedupe } from "../../persistent-dedupe-CP4BKJq-.js";
import "../../state-paths-7tNathRX.js";
import { C as formatBlueBubblesChatTarget, L as resolveBlueBubblesEffectiveAllowPrivateNetworkFromConfig, M as resolveBlueBubblesServerAccount, O as normalizeBlueBubblesHandle, P as resolveBlueBubblesAccount, R as resolveBlueBubblesPrivateNetworkConfigValue, S as extractHandleFromChatGuid, T as isAllowedBlueBubblesSender, b as resolveTapbackContext, c as createBlueBubblesClientFromParts, d as buildMessagePlaceholder, f as formatGroupAllowlistEntry, h as normalizeParticipantList, m as formatReplyTag, p as formatGroupMembers, r as isBlueBubblesPrivateApiEnabled, v as parseTapbackText, x as buildBlueBubblesChatContextFromTarget, y as resolveGroupFlagFromChatGuid } from "./probe-CgEZdzvn.js";
import "./secret-input-O0PpiIJK.js";
import { t as getBlueBubblesRuntime } from "./runtime-0m_O8oDo.js";
import { i as resolveBlueBubblesInboundConversationId } from "./conversation-id-B6eZ6fH2.js";
import { _ as fetchBlueBubblesMessageAttachments, a as resolveBlueBubblesMessageId, b as sendMessageBlueBubbles, g as downloadBlueBubblesAttachment, i as rememberBlueBubblesReplyCache, n as sendBlueBubblesReaction, o as resolveReplyContextFromCache, p as sendBlueBubblesTyping, r as getShortIdForUuid, t as normalizeBlueBubblesReactionInputStrict, u as markBlueBubblesChatRead, v as sendBlueBubblesAttachment, y as resolveChatGuidForTarget } from "./reactions-CtOxOGhB.js";
import fs, { constants } from "node:fs";
import path, { join } from "node:path";
import fs$1, { access, readdir } from "node:fs/promises";
import os from "node:os";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
//#region extensions/bluebubbles/src/inbound-dedupe.ts
const DEDUP_TTL_MS = 10080 * 60 * 1e3;
const MEMORY_MAX_SIZE = 5e3;
const FILE_MAX_ENTRIES = 5e4;
const MAX_GUID_CHARS = 512;
function resolveStateDirFromEnv(env = process.env) {
	if (env.VITEST || env.NODE_ENV === "test") {
		const name = "openclaw-vitest-" + process.pid;
		return path.join(resolvePreferredOpenClawTmpDir(), name);
	}
	return resolveStateDir(env);
}
function resolveLegacyNamespaceFilePath(namespace) {
	const safe = namespace.replace(/[^a-zA-Z0-9_-]/g, "_") || "global";
	return path.join(resolveStateDirFromEnv(), "bluebubbles", "inbound-dedupe", `${safe}.json`);
}
function resolveNamespaceFilePath(namespace) {
	const safePrefix = namespace.replace(/[^a-zA-Z0-9_-]/g, "_") || "ns";
	const hash = createHash("sha256").update(namespace, "utf8").digest("hex").slice(0, 12);
	const dir = path.join(resolveStateDirFromEnv(), "bluebubbles", "inbound-dedupe");
	const newPath = path.join(dir, `${safePrefix}__${hash}.json`);
	migrateLegacyDedupeFile(namespace, newPath);
	return newPath;
}
const migratedNamespaces = /* @__PURE__ */ new Set();
function migrateLegacyDedupeFile(namespace, newPath) {
	if (migratedNamespaces.has(namespace)) return;
	migratedNamespaces.add(namespace);
	try {
		const legacyPath = resolveLegacyNamespaceFilePath(namespace);
		if (legacyPath === newPath) return;
		if (!fs.existsSync(legacyPath)) return;
		if (!fs.existsSync(newPath)) fs.renameSync(legacyPath, newPath);
		else fs.unlinkSync(legacyPath);
	} catch {}
}
function buildPersistentImpl() {
	return createClaimableDedupe({
		ttlMs: DEDUP_TTL_MS,
		memoryMaxSize: MEMORY_MAX_SIZE,
		fileMaxEntries: FILE_MAX_ENTRIES,
		resolveFilePath: resolveNamespaceFilePath
	});
}
let impl = buildPersistentImpl();
function sanitizeGuid(guid) {
	const trimmed = guid?.trim();
	if (!trimmed) return null;
	if (trimmed.length > MAX_GUID_CHARS) return null;
	return trimmed;
}
/**
* Resolve the canonical dedupe key for a BlueBubbles inbound message.
*
* Mirrors `monitor-debounce.ts`'s `buildKey`: BlueBubbles sends URL-preview
* / sticker "balloon" events with a different `messageId` than the text
* message they belong to, and the debouncer coalesces the two only when
* both `balloonBundleId` AND `associatedMessageGuid` are present. We gate
* on the same pair so that regular replies — which also set
* `associatedMessageGuid` (pointing at the parent message) but have no
* `balloonBundleId` — are NOT collapsed onto their parent's dedupe key.
*
* Known tradeoff: `combineDebounceEntries` clears `balloonBundleId` on
* merged entries while keeping `associatedMessageGuid`, so a post-merge
* balloon+text message here will fall back to its `messageId`. A later
* MessagePoller replay that arrives in a different text-first/balloon-first
* order could therefore produce a different `messageId` at merge time and
* bypass this dedupe for that one message. That edge case is strictly
* narrower than the alternative — which would dedupe every distinct user
* reply against the same parent GUID and silently drop real messages.
*/
function resolveBlueBubblesInboundDedupeKey(message) {
	const balloonBundleId = message.balloonBundleId?.trim();
	const associatedMessageGuid = message.associatedMessageGuid?.trim();
	let base;
	if (balloonBundleId && associatedMessageGuid) base = associatedMessageGuid;
	else base = message.messageId?.trim() || void 0;
	if (!base) return;
	if (message.eventType === "updated-message") return `${base}:updated`;
	return base;
}
/**
* Attempt to claim an inbound BlueBubbles message GUID.
*
* - `claimed`: caller should process the message, then call `finalize()` on
*   success (persists the GUID) or `release()` on failure (lets a later
*   replay try again).
* - `duplicate`: we've already committed this GUID; caller should drop.
* - `inflight`: another claim is currently in progress; caller should drop
*   rather than race.
* - `skip`: GUID was missing or invalid — caller should continue processing
*   without dedup (no finalize/release needed).
*/
async function claimBlueBubblesInboundMessage(params) {
	const normalized = sanitizeGuid(params.guid);
	if (!normalized) return { kind: "skip" };
	const claim = await impl.claim(normalized, {
		namespace: params.accountId,
		onDiskError: params.onDiskError
	});
	if (claim.kind === "duplicate") return { kind: "duplicate" };
	if (claim.kind === "inflight") return { kind: "inflight" };
	return {
		kind: "claimed",
		finalize: async () => {
			await impl.commit(normalized, {
				namespace: params.accountId,
				onDiskError: params.onDiskError
			});
		},
		release: () => {
			impl.release(normalized, { namespace: params.accountId });
		}
	};
}
/**
* Mark a set of source messageIds as already processed, without going through
* the `claim()` protocol. Intended for the coalesced-batch case: when the
* debouncer merges N webhook events into one agent turn, only the primary
* messageId reaches `claimBlueBubblesInboundMessage`. The remaining source
* messageIds must still be remembered so a later MessagePoller replay of any
* single source event is recognized as a duplicate rather than re-processed.
*
* Best-effort — disk errors on secondary commits are surfaced via
* `onDiskError` but never thrown, so a single persistence hiccup cannot block
* the caller's main finalize path.
*/
async function commitBlueBubblesCoalescedMessageIds(params) {
	for (const raw of params.messageIds) {
		const normalized = sanitizeGuid(raw);
		if (!normalized) continue;
		await impl.commit(normalized, {
			namespace: params.accountId,
			onDiskError: params.onDiskError
		});
	}
}
/**
* Ensure the legacy→hashed dedupe file migration runs and the on-disk
* store is warmed into memory for the given account. Call before any
* catchup replay so already-handled GUIDs are recognized even when the
* file-naming convention changed between versions.
*/
async function warmupBlueBubblesInboundDedupe(accountId) {
	resolveNamespaceFilePath(accountId);
	await impl.warmup(accountId);
}
//#endregion
//#region extensions/bluebubbles/src/conversation-route.ts
function resolveBlueBubblesConversationRoute(params) {
	let route = resolveAgentRoute({
		cfg: params.cfg,
		channel: "bluebubbles",
		accountId: params.accountId,
		peer: {
			kind: params.isGroup ? "group" : "direct",
			id: params.peerId
		}
	});
	const conversationId = resolveBlueBubblesInboundConversationId({
		isGroup: params.isGroup,
		sender: params.sender,
		chatId: params.chatId,
		chatGuid: params.chatGuid,
		chatIdentifier: params.chatIdentifier
	});
	if (!conversationId) return route;
	route = resolveConfiguredBindingRoute({
		cfg: params.cfg,
		route,
		conversation: {
			channel: "bluebubbles",
			accountId: params.accountId,
			conversationId
		}
	}).route;
	const runtimeRoute = resolveRuntimeConversationBindingRoute({
		route,
		conversation: {
			channel: "bluebubbles",
			accountId: params.accountId,
			conversationId
		}
	});
	route = runtimeRoute.route;
	if (runtimeRoute.bindingRecord && !runtimeRoute.boundSessionKey) logVerbose$1(`bluebubbles: plugin-bound conversation ${conversationId}`);
	else if (runtimeRoute.boundSessionKey) logVerbose$1(`bluebubbles: routed via bound conversation ${conversationId} -> ${runtimeRoute.boundSessionKey}`);
	return route;
}
//#endregion
//#region extensions/bluebubbles/src/history.ts
function resolveAccount(params) {
	return resolveBlueBubblesServerAccount(params);
}
const MAX_HISTORY_FETCH_LIMIT = 100;
const HISTORY_SCAN_MULTIPLIER = 8;
const MAX_HISTORY_SCAN_MESSAGES = 500;
const MAX_HISTORY_BODY_CHARS = 2e3;
function clampHistoryLimit(limit) {
	if (!Number.isFinite(limit)) return 0;
	const normalized = Math.floor(limit);
	if (normalized <= 0) return 0;
	return Math.min(normalized, MAX_HISTORY_FETCH_LIMIT);
}
function truncateHistoryBody$1(text) {
	if (text.length <= MAX_HISTORY_BODY_CHARS) return text;
	return `${text.slice(0, MAX_HISTORY_BODY_CHARS).trimEnd()}...`;
}
/**
* Fetch message history from BlueBubbles API for a specific chat.
* This provides the initial backfill for both group chats and DMs.
*/
async function fetchBlueBubblesHistory(chatIdentifier, limit, opts = {}) {
	const effectiveLimit = clampHistoryLimit(limit);
	if (!chatIdentifier.trim() || effectiveLimit <= 0) return {
		entries: [],
		resolved: true
	};
	let baseUrl;
	let password;
	let allowPrivateNetwork = false;
	try {
		({baseUrl, password, allowPrivateNetwork} = resolveAccount(opts));
	} catch {
		return {
			entries: [],
			resolved: false
		};
	}
	const client = createBlueBubblesClientFromParts({
		baseUrl,
		password,
		allowPrivateNetwork,
		timeoutMs: opts.timeoutMs ?? 1e4
	});
	const possiblePaths = [
		`/api/v1/chat/${encodeURIComponent(chatIdentifier)}/messages?limit=${effectiveLimit}&sort=DESC`,
		`/api/v1/messages?chatGuid=${encodeURIComponent(chatIdentifier)}&limit=${effectiveLimit}`,
		`/api/v1/chat/${encodeURIComponent(chatIdentifier)}/message?limit=${effectiveLimit}`
	];
	for (const path of possiblePaths) try {
		const res = await client.request({
			method: "GET",
			path,
			timeoutMs: opts.timeoutMs ?? 1e4
		});
		if (!res.ok) continue;
		const data = await res.json().catch(() => null);
		if (!data) continue;
		let messages = [];
		if (Array.isArray(data)) messages = data;
		else if (data.data && Array.isArray(data.data)) messages = data.data;
		else if (data.messages && Array.isArray(data.messages)) messages = data.messages;
		else continue;
		const historyEntries = [];
		const maxScannedMessages = Math.min(Math.max(effectiveLimit * HISTORY_SCAN_MULTIPLIER, effectiveLimit), MAX_HISTORY_SCAN_MESSAGES);
		for (let i = 0; i < messages.length && i < maxScannedMessages; i++) {
			const msg = messages[i];
			const text = msg.text?.trim();
			if (!text) continue;
			const sender = msg.is_from_me ? "me" : msg.sender?.display_name || msg.sender?.address || msg.handle_id || "Unknown";
			const timestamp = msg.date_created || msg.date_delivered;
			historyEntries.push({
				sender,
				body: truncateHistoryBody$1(text),
				timestamp,
				messageId: msg.guid
			});
		}
		historyEntries.sort((a, b) => {
			return (a.timestamp || 0) - (b.timestamp || 0);
		});
		return {
			entries: historyEntries.slice(0, effectiveLimit),
			resolved: true
		};
	} catch {
		continue;
	}
	return {
		entries: [],
		resolved: false
	};
}
//#endregion
//#region extensions/bluebubbles/src/media-send.ts
const HTTP_URL_RE = /^https?:\/\//i;
const MB = 1024 * 1024;
function assertMediaWithinLimit(sizeBytes, maxBytes) {
	if (typeof maxBytes !== "number" || maxBytes <= 0) return;
	if (sizeBytes <= maxBytes) return;
	const maxLabel = (maxBytes / MB).toFixed(0);
	const sizeLabel = (sizeBytes / MB).toFixed(2);
	throw new Error(`Media exceeds ${maxLabel}MB limit (got ${sizeLabel}MB)`);
}
function resolveLocalMediaPath(source) {
	if (!source.startsWith("file://")) return source;
	try {
		return safeFileURLToPath(source);
	} catch {
		throw new Error(`Invalid file:// URL: ${source}`);
	}
}
function expandHomePath(input) {
	if (input === "~") return os.homedir();
	if (input.startsWith("~/") || input.startsWith(`~${path.sep}`)) return path.join(os.homedir(), input.slice(2));
	return input;
}
function resolveConfiguredPath(input) {
	const trimmed = input.trim();
	if (!trimmed) throw new Error("Empty mediaLocalRoots entry is not allowed");
	if (trimmed.startsWith("file://")) try {
		return safeFileURLToPath(trimmed);
	} catch {
		throw new Error(`Invalid file:// URL in mediaLocalRoots: ${input}`);
	}
	const resolved = expandHomePath(trimmed);
	if (!path.isAbsolute(resolved)) throw new Error(`mediaLocalRoots entries must be absolute paths: ${input}`);
	return resolved;
}
function isPathInsideRoot(candidate, root) {
	const normalizedCandidate = path.normalize(candidate);
	const normalizedRoot = path.normalize(root);
	const rootWithSep = normalizedRoot.endsWith(path.sep) ? normalizedRoot : normalizedRoot + path.sep;
	if (process.platform === "win32") {
		const candidateLower = lowercasePreservingWhitespace(normalizedCandidate);
		const rootLower = lowercasePreservingWhitespace(normalizedRoot);
		const rootWithSepLower = lowercasePreservingWhitespace(rootWithSep);
		return candidateLower === rootLower || candidateLower.startsWith(rootWithSepLower);
	}
	return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(rootWithSep);
}
function resolveMediaLocalRoots(params) {
	return (resolveBlueBubblesAccount({
		cfg: params.cfg,
		accountId: params.accountId
	}).config.mediaLocalRoots ?? []).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}
async function assertLocalMediaPathAllowed(params) {
	if (params.localRoots.length === 0) throw new Error(`Local BlueBubbles media paths are disabled by default. Set channels.bluebubbles.mediaLocalRoots${params.accountId ? ` or channels.bluebubbles.accounts.${params.accountId}.mediaLocalRoots` : ""} to explicitly allow local file directories.`);
	const resolvedLocalPath = path.resolve(params.localPath);
	const supportsNoFollow = process.platform !== "win32" && "O_NOFOLLOW" in constants;
	const openFlags = constants.O_RDONLY | (supportsNoFollow ? constants.O_NOFOLLOW : 0);
	for (const rootEntry of params.localRoots) {
		const resolvedRootInput = resolveConfiguredPath(rootEntry);
		const relativeToRoot = path.relative(resolvedRootInput, resolvedLocalPath);
		if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot) || relativeToRoot === "") continue;
		let rootReal;
		try {
			rootReal = await fs$1.realpath(resolvedRootInput);
		} catch {
			rootReal = path.resolve(resolvedRootInput);
		}
		const candidatePath = path.resolve(rootReal, relativeToRoot);
		if (!isPathInsideRoot(candidatePath, rootReal)) continue;
		let handle = null;
		try {
			handle = await fs$1.open(candidatePath, openFlags);
			const realPath = await fs$1.realpath(candidatePath);
			if (!isPathInsideRoot(realPath, rootReal)) continue;
			const stat = await handle.stat();
			if (!stat.isFile()) continue;
			const realStat = await fs$1.stat(realPath);
			if (stat.ino !== realStat.ino || stat.dev !== realStat.dev) continue;
			return {
				data: await handle.readFile(),
				realPath,
				sizeBytes: stat.size
			};
		} catch {
			continue;
		} finally {
			if (handle) await handle.close().catch(() => {});
		}
	}
	throw new Error(`Local media path is not under any configured mediaLocalRoots entry: ${params.localPath}`);
}
function resolveFilenameFromSource(source) {
	return basenameFromMediaSource(source);
}
async function sendBlueBubblesMedia(params) {
	const { cfg, to, mediaUrl, mediaPath, mediaBuffer, contentType, filename, caption, replyToId, accountId, asVoice } = params;
	const core = getBlueBubblesRuntime();
	const maxBytes = resolveChannelMediaMaxBytes({
		cfg,
		resolveChannelLimitMb: ({ cfg, accountId }) => (cfg.channels?.bluebubbles?.accounts?.[accountId])?.mediaMaxMb ?? cfg.channels?.bluebubbles?.mediaMaxMb,
		accountId
	});
	const mediaLocalRoots = resolveMediaLocalRoots({
		cfg,
		accountId
	});
	let buffer;
	let resolvedContentType = contentType ?? void 0;
	let resolvedFilename = filename ?? void 0;
	if (mediaBuffer) {
		assertMediaWithinLimit(mediaBuffer.byteLength, maxBytes);
		buffer = mediaBuffer;
		if (!resolvedContentType) {
			const hint = mediaPath ?? mediaUrl;
			resolvedContentType = await core.media.detectMime({
				buffer: Buffer.isBuffer(mediaBuffer) ? mediaBuffer : Buffer.from(mediaBuffer),
				filePath: hint
			}) ?? void 0;
		}
		if (!resolvedFilename) resolvedFilename = resolveFilenameFromSource(mediaPath ?? mediaUrl);
	} else {
		const source = mediaPath ?? mediaUrl;
		if (!source) throw new Error("BlueBubbles media delivery requires mediaUrl, mediaPath, or mediaBuffer.");
		if (HTTP_URL_RE.test(source)) {
			const fetched = await core.channel.media.fetchRemoteMedia({
				url: source,
				maxBytes: typeof maxBytes === "number" && maxBytes > 0 ? maxBytes : void 0
			});
			buffer = fetched.buffer;
			resolvedContentType = resolvedContentType ?? fetched.contentType ?? void 0;
			resolvedFilename = resolvedFilename ?? fetched.fileName;
		} else {
			const localFile = await assertLocalMediaPathAllowed({
				localPath: expandHomePath(resolveLocalMediaPath(source)),
				localRoots: mediaLocalRoots,
				accountId
			});
			if (typeof maxBytes === "number" && maxBytes > 0) assertMediaWithinLimit(localFile.sizeBytes, maxBytes);
			const data = localFile.data;
			assertMediaWithinLimit(data.byteLength, maxBytes);
			buffer = new Uint8Array(data);
			if (!resolvedContentType) resolvedContentType = await core.media.detectMime({
				buffer: data,
				filePath: localFile.realPath
			}) ?? void 0;
			if (!resolvedFilename) resolvedFilename = resolveFilenameFromSource(localFile.realPath);
		}
	}
	const replyToMessageGuid = replyToId?.trim() ? resolveBlueBubblesMessageId(replyToId.trim(), {
		requireKnownShortId: true,
		chatContext: buildBlueBubblesChatContextFromTarget(to)
	}) : void 0;
	const attachmentResult = await sendBlueBubblesAttachment({
		to,
		buffer,
		filename: resolvedFilename ?? "attachment",
		contentType: resolvedContentType ?? void 0,
		replyToMessageGuid,
		asVoice,
		opts: {
			cfg,
			accountId
		}
	});
	const trimmedCaption = caption?.trim();
	if (trimmedCaption) await sendMessageBlueBubbles(to, trimmedCaption, {
		cfg,
		accountId,
		replyToMessageGuid
	});
	return attachmentResult;
}
//#endregion
//#region extensions/bluebubbles/src/monitor-reply-fetch.ts
const DEFAULT_REPLY_FETCH_TIMEOUT_MS = 5e3;
const REPLY_TO_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const REPLY_TO_ID_MAX_LENGTH = 128;
const PART_INDEX_REPLY_TO_ID_PATTERN = /^p:\d{1,10}\/([A-Za-z0-9._:-]+)$/;
const PART_INDEX_REPLY_TO_ID_MAX_LENGTH = REPLY_TO_ID_MAX_LENGTH + 2 + 10 + 1;
/**
* In-flight dedupe so concurrent webhooks for replies to the same message
* (e.g., several recipients in a group chat replying near-simultaneously)
* coalesce into a single BlueBubbles HTTP fetch.
*
* Key shape: `${accountId}:${replyToId}` to keep accounts isolated.
*/
const inflight = /* @__PURE__ */ new Map();
/**
* Best-effort fallback: when the local in-memory reply cache misses, ask the
* BlueBubbles HTTP API for the original message so the agent still gets reply
* context. Returns `null` on any failure (network error, non-2xx, parse error,
* empty payload). Never throws.
*
* On success, the cache is populated so subsequent replies to the same message
* resolve from RAM without another round-trip.
*
* Cache misses happen in legitimate, common deployments: multi-instance setups
* sharing one BB account, container/process restarts, cross-tenant shared
* groups, and long-lived chats where TTL/LRU has evicted the message.
*/
function fetchBlueBubblesReplyContext(params) {
	const replyToId = sanitizeReplyToId(params.replyToId);
	if (!replyToId || !params.baseUrl || !params.password) return Promise.resolve(null);
	const key = `${params.accountId}:${replyToId}`;
	const existing = inflight.get(key);
	if (existing) return existing;
	const promise = runFetch(params, replyToId).finally(() => {
		inflight.delete(key);
	});
	inflight.set(key, promise);
	return promise;
}
/**
* Strip a part-index prefix (`p:0/<guid>` → `<guid>`) and validate the result
* against the GUID character set + length cap. Returns null when the id is
* empty or cannot safely be used as a path segment.
*/
function sanitizeReplyToId(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const bare = trimmed.includes("/") ? trimmed.split("/").pop() ?? "" : trimmed;
	if (!bare || bare.length > REPLY_TO_ID_MAX_LENGTH || !REPLY_TO_ID_PATTERN.test(bare)) return null;
	return bare;
}
function normalizePartIndexReplyToIdAlias(raw, bareReplyToId) {
	const trimmed = raw.trim();
	if (trimmed.length > PART_INDEX_REPLY_TO_ID_MAX_LENGTH) return null;
	const match = PART_INDEX_REPLY_TO_ID_PATTERN.exec(trimmed);
	if (!match || match[1] !== bareReplyToId) return null;
	return trimmed;
}
async function runFetch(params, replyToId) {
	const client = (params.clientFactory ?? createBlueBubblesClientFromParts)({
		accountId: params.accountId,
		baseUrl: params.baseUrl,
		password: params.password,
		allowPrivateNetwork: resolveBlueBubblesEffectiveAllowPrivateNetworkFromConfig({
			baseUrl: params.baseUrl,
			config: params.accountConfig
		}),
		allowPrivateNetworkConfig: resolveBlueBubblesPrivateNetworkConfigValue(params.accountConfig),
		timeoutMs: params.timeoutMs ?? DEFAULT_REPLY_FETCH_TIMEOUT_MS
	});
	try {
		const response = await client.request({
			method: "GET",
			path: `/api/v1/message/${encodeURIComponent(replyToId)}`,
			timeoutMs: params.timeoutMs ?? DEFAULT_REPLY_FETCH_TIMEOUT_MS
		});
		if (!response.ok) return null;
		const json = await response.json();
		const data = json.data ?? json;
		if (!data || typeof data !== "object") return null;
		const body = extractBody(data);
		const sender = extractSender(data);
		if (!body && !sender) return null;
		const cacheEntry = {
			accountId: params.accountId,
			messageId: replyToId,
			chatGuid: params.chatGuid,
			chatIdentifier: params.chatIdentifier,
			chatId: params.chatId,
			senderLabel: sender,
			body,
			timestamp: Date.now()
		};
		rememberBlueBubblesReplyCache(cacheEntry);
		const partIndexReplyToId = normalizePartIndexReplyToIdAlias(params.replyToId, replyToId);
		if (partIndexReplyToId) rememberBlueBubblesReplyCache({
			...cacheEntry,
			messageId: partIndexReplyToId
		});
		return {
			body,
			sender
		};
	} catch {
		return null;
	}
}
function extractBody(data) {
	return normalizeOptionalString(data.text) ?? normalizeOptionalString(data.body) ?? normalizeOptionalString(data.subject);
}
function asRecord(value) {
	return value !== null && typeof value === "object" ? value : void 0;
}
function extractSender(data) {
	const handle = asRecord(data.handle) ?? asRecord(data.sender);
	const raw = normalizeOptionalString(handle?.address) ?? normalizeOptionalString(handle?.id) ?? normalizeOptionalString(data.senderId) ?? normalizeOptionalString(data.sender);
	if (!raw) return;
	return normalizeBlueBubblesHandle(raw) || raw;
}
//#endregion
//#region extensions/bluebubbles/src/monitor-self-chat-cache.ts
const SELF_CHAT_TTL_MS = 1e4;
const MAX_SELF_CHAT_CACHE_ENTRIES = 512;
const CLEANUP_MIN_INTERVAL_MS = 1e3;
const MAX_SELF_CHAT_BODY_CHARS = 32768;
const cache = /* @__PURE__ */ new Map();
let lastCleanupAt = 0;
function normalizeBody(body) {
	if (!body) return null;
	const normalized = (body.length > MAX_SELF_CHAT_BODY_CHARS ? body.slice(0, MAX_SELF_CHAT_BODY_CHARS) : body).replace(/\r\n?/g, "\n").trim();
	return normalized ? normalized : null;
}
function isUsableTimestamp(timestamp) {
	return typeof timestamp === "number" && Number.isFinite(timestamp);
}
function digestText(text) {
	return createHash("sha256").update(text).digest("base64url");
}
function resolveCanonicalChatTarget(parts) {
	const handleFromGuid = parts.chatGuid ? extractHandleFromChatGuid(parts.chatGuid) : null;
	if (handleFromGuid) return handleFromGuid;
	const normalizedIdentifier = normalizeBlueBubblesHandle(parts.chatIdentifier ?? "");
	if (normalizedIdentifier) return normalizedIdentifier;
	return normalizeOptionalString(parts.chatGuid) ?? normalizeOptionalString(parts.chatIdentifier) ?? (typeof parts.chatId === "number" ? String(parts.chatId) : null);
}
function buildScope(parts) {
	const target = resolveCanonicalChatTarget(parts) ?? parts.senderId;
	return `${parts.accountId}:${target}`;
}
function cleanupExpired(now = Date.now()) {
	if (lastCleanupAt !== 0 && now >= lastCleanupAt && now - lastCleanupAt < CLEANUP_MIN_INTERVAL_MS) return;
	lastCleanupAt = now;
	for (const [key, seenAt] of cache.entries()) if (now - seenAt > SELF_CHAT_TTL_MS) cache.delete(key);
}
function enforceSizeCap() {
	while (cache.size > MAX_SELF_CHAT_CACHE_ENTRIES) {
		const oldestKey = cache.keys().next().value;
		if (typeof oldestKey !== "string") break;
		cache.delete(oldestKey);
	}
}
function buildKey(lookup) {
	const body = normalizeBody(lookup.body);
	if (!body || !isUsableTimestamp(lookup.timestamp)) return null;
	return `${buildScope(lookup)}:${lookup.timestamp}:${digestText(body)}`;
}
function rememberBlueBubblesSelfChatCopy(lookup) {
	cleanupExpired();
	const key = buildKey(lookup);
	if (!key) return;
	cache.set(key, Date.now());
	enforceSizeCap();
}
function hasBlueBubblesSelfChatCopy(lookup) {
	cleanupExpired();
	const key = buildKey(lookup);
	if (!key) return false;
	const seenAt = cache.get(key);
	return typeof seenAt === "number" && Date.now() - seenAt <= SELF_CHAT_TTL_MS;
}
//#endregion
//#region extensions/bluebubbles/src/participant-contact-names.ts
const execFileAsync = promisify(execFile);
const CONTACT_NAME_CACHE_TTL_MS = 3600 * 1e3;
const NEGATIVE_CONTACT_NAME_CACHE_TTL_MS = 300 * 1e3;
const MAX_PARTICIPANT_CONTACT_NAME_CACHE_ENTRIES = 2048;
const SQLITE_MAX_BUFFER = 8 * 1024 * 1024;
const SQLITE_PHONE_DIGITS_SQL = "REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(p.ZFULLNUMBER, ''), ' ', ''), '(', ''), ')', ''), '-', ''), '+', ''), '.', ''), '\n', ''), '\r', '')";
const participantContactNameCache = /* @__PURE__ */ new Map();
function normalizePhoneLookupKey(value) {
	const digits = value.replace(/\D/g, "");
	if (!digits) return null;
	const normalized = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
	return normalized.length >= 7 ? normalized : null;
}
function uniqueNormalizedPhoneLookupKeys(phoneKeys) {
	const unique = /* @__PURE__ */ new Set();
	for (const phoneKey of phoneKeys) {
		const normalized = normalizePhoneLookupKey(phoneKey);
		if (normalized) unique.add(normalized);
	}
	return [...unique];
}
function resolveParticipantPhoneLookupKey(participant) {
	if (participant.id.includes("@")) return null;
	return normalizePhoneLookupKey(participant.id);
}
function trimParticipantContactNameCache(now) {
	for (const [phoneKey, entry] of participantContactNameCache) if (entry.expiresAt <= now) participantContactNameCache.delete(phoneKey);
	while (participantContactNameCache.size > MAX_PARTICIPANT_CONTACT_NAME_CACHE_ENTRIES) {
		const oldestPhoneKey = participantContactNameCache.keys().next().value;
		if (!oldestPhoneKey) return;
		participantContactNameCache.delete(oldestPhoneKey);
	}
}
function readFreshCacheEntry(phoneKey, now) {
	const cached = participantContactNameCache.get(phoneKey);
	if (!cached) return null;
	if (cached.expiresAt <= now) {
		participantContactNameCache.delete(phoneKey);
		return null;
	}
	participantContactNameCache.delete(phoneKey);
	participantContactNameCache.set(phoneKey, cached);
	return cached;
}
function writeCacheEntry(phoneKey, name, now) {
	participantContactNameCache.delete(phoneKey);
	participantContactNameCache.set(phoneKey, {
		name,
		expiresAt: now + (name ? CONTACT_NAME_CACHE_TTL_MS : NEGATIVE_CONTACT_NAME_CACHE_TTL_MS)
	});
	trimParticipantContactNameCache(now);
}
function buildAddressBookSourcesDir(homeDir) {
	const trimmedHomeDir = homeDir?.trim();
	if (!trimmedHomeDir) return null;
	return join(trimmedHomeDir, "Library", "Application Support", "AddressBook", "Sources");
}
async function fileExists(path, deps) {
	try {
		await deps.access(path);
		return true;
	} catch {
		return false;
	}
}
async function listContactsDatabases(deps) {
	const sourcesDir = buildAddressBookSourcesDir(deps.homeDir);
	if (!sourcesDir) return [];
	let entries = [];
	try {
		entries = await deps.readdir(sourcesDir);
	} catch {
		return [];
	}
	const databases = [];
	for (const entry of entries) {
		const dbPath = join(sourcesDir, entry, "AddressBook-v22.abcddb");
		if (await fileExists(dbPath, deps)) databases.push(dbPath);
	}
	return databases;
}
function buildSqlitePhoneKeyList(phoneKeys) {
	return uniqueNormalizedPhoneLookupKeys(phoneKeys).map((phoneKey) => `'${phoneKey}'`).join(", ");
}
async function queryContactsDatabase(dbPath, phoneKeys, deps) {
	const sqlitePhoneKeyList = buildSqlitePhoneKeyList(phoneKeys);
	if (!sqlitePhoneKeyList) return [];
	const sql = `
SELECT digits, name
FROM (
  SELECT
    ${SQLITE_PHONE_DIGITS_SQL} AS digits,
    TRIM(
      CASE
        WHEN TRIM(COALESCE(r.ZFIRSTNAME, '') || ' ' || COALESCE(r.ZLASTNAME, '')) != ''
          THEN TRIM(COALESCE(r.ZFIRSTNAME, '') || ' ' || COALESCE(r.ZLASTNAME, ''))
        ELSE COALESCE(r.ZORGANIZATION, '')
      END
    ) AS name
  FROM ZABCDRECORD r
  JOIN ZABCDPHONENUMBER p ON p.ZOWNER = r.Z_PK
  WHERE p.ZFULLNUMBER IS NOT NULL
)
WHERE digits IN (${sqlitePhoneKeyList})
  AND name != '';
`;
	const options = {
		encoding: "utf8",
		maxBuffer: SQLITE_MAX_BUFFER
	};
	const { stdout } = await deps.execFileAsync("sqlite3", [
		"-separator",
		"	",
		dbPath,
		sql
	], options);
	const rows = [];
	for (const line of stdout.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const [digitsRaw, ...nameParts] = trimmed.split("	");
		const phoneKey = normalizePhoneLookupKey(digitsRaw ?? "");
		const name = nameParts.join("	").trim();
		if (!phoneKey || !name) continue;
		rows.push({
			phoneKey,
			name
		});
	}
	return rows;
}
async function resolvePhoneNamesFromMacOsContacts(phoneKeys, deps) {
	const normalizedPhoneKeys = uniqueNormalizedPhoneLookupKeys(phoneKeys);
	if (normalizedPhoneKeys.length === 0) return /* @__PURE__ */ new Map();
	const databases = await listContactsDatabases(deps);
	if (databases.length === 0) return /* @__PURE__ */ new Map();
	const unresolved = new Set(normalizedPhoneKeys);
	const resolved = /* @__PURE__ */ new Map();
	for (const dbPath of databases) {
		let rows = [];
		try {
			rows = await queryContactsDatabase(dbPath, [...unresolved], deps);
		} catch {
			continue;
		}
		for (const row of rows) {
			if (!unresolved.has(row.phoneKey) || resolved.has(row.phoneKey)) continue;
			resolved.set(row.phoneKey, row.name);
			unresolved.delete(row.phoneKey);
			if (unresolved.size === 0) return resolved;
		}
	}
	return resolved;
}
function resolveLookupDeps(deps) {
	const merged = { ...deps };
	return {
		platform: merged.platform ?? process.platform,
		now: merged.now ?? (() => Date.now()),
		resolvePhoneNames: merged.resolvePhoneNames,
		homeDir: merged.homeDir ?? process.env.HOME,
		readdir: merged.readdir ?? readdir,
		access: merged.access ?? access,
		execFileAsync: merged.execFileAsync ?? execFileAsync
	};
}
async function enrichBlueBubblesParticipantsWithContactNames(participants, deps) {
	if (!Array.isArray(participants) || participants.length === 0) return [];
	const resolvedDeps = resolveLookupDeps(deps);
	const lookup = resolvedDeps.resolvePhoneNames ?? ((phoneKeys) => resolvePhoneNamesFromMacOsContacts(phoneKeys, resolvedDeps));
	if (!(Boolean(resolvedDeps.resolvePhoneNames) || resolvedDeps.platform === "darwin")) return participants;
	const nowMs = resolvedDeps.now();
	trimParticipantContactNameCache(nowMs);
	const pendingPhoneKeys = /* @__PURE__ */ new Set();
	const cachedNames = /* @__PURE__ */ new Map();
	for (const participant of participants) {
		if (participant.name?.trim()) continue;
		const phoneKey = resolveParticipantPhoneLookupKey(participant);
		if (!phoneKey) continue;
		const cached = readFreshCacheEntry(phoneKey, nowMs);
		if (cached?.name) {
			cachedNames.set(phoneKey, cached.name);
			continue;
		}
		if (!cached) pendingPhoneKeys.add(phoneKey);
	}
	if (pendingPhoneKeys.size > 0) try {
		const resolved = await lookup([...pendingPhoneKeys]);
		for (const phoneKey of pendingPhoneKeys) {
			const name = normalizeOptionalString(resolved.get(phoneKey));
			writeCacheEntry(phoneKey, name, nowMs);
			if (name) cachedNames.set(phoneKey, name);
		}
	} catch {
		return participants;
	}
	let didChange = false;
	const enriched = participants.map((participant) => {
		if (participant.name?.trim()) return participant;
		const phoneKey = resolveParticipantPhoneLookupKey(participant);
		if (!phoneKey) return participant;
		const name = cachedNames.get(phoneKey)?.trim();
		if (!name) return participant;
		didChange = true;
		return {
			...participant,
			name
		};
	});
	return didChange ? enriched : participants;
}
//#endregion
//#region extensions/bluebubbles/src/monitor-processing.ts
const DEFAULT_TEXT_LIMIT = 4e3;
const invalidAckReactions = /* @__PURE__ */ new Set();
const REPLY_DIRECTIVE_TAG_RE = /\[\[\s*(?:reply_to_current|reply_to\s*:\s*[^\]\n]+)\s*\]\]/gi;
const PENDING_OUTBOUND_MESSAGE_ID_TTL_MS = 120 * 1e3;
const pendingOutboundMessageIds = [];
let pendingOutboundMessageIdCounter = 0;
function normalizeSnippet(value) {
	return normalizeOptionalLowercaseString(stripMarkdown(value).replace(/\s+/g, " ")) ?? "";
}
function extractBlueBubblesChatGuid(chat) {
	const candidates = [
		chat.chatGuid,
		chat.guid,
		chat.chat_guid
	];
	for (const candidate of candidates) if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
}
function extractBlueBubblesChatId(chat) {
	const candidates = [
		chat.chatId,
		chat.id,
		chat.chat_id
	];
	for (const candidate of candidates) if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
}
function extractChatIdentifierFromChatGuid(chatGuid) {
	const parts = chatGuid.split(";");
	if (parts.length < 3) return;
	return parts[2]?.trim() || void 0;
}
function extractBlueBubblesChatIdentifier(chat) {
	const candidates = [
		chat.chatIdentifier,
		chat.chat_identifier,
		chat.identifier
	];
	for (const candidate of candidates) if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
	const chatGuid = extractBlueBubblesChatGuid(chat);
	return chatGuid ? extractChatIdentifierFromChatGuid(chatGuid) : void 0;
}
async function queryBlueBubblesChats(params) {
	const res = await createBlueBubblesClientFromParts({
		baseUrl: params.baseUrl,
		password: params.password,
		allowPrivateNetwork: params.allowPrivateNetwork === true,
		timeoutMs: params.timeoutMs
	}).request({
		method: "POST",
		path: "/api/v1/chat/query",
		body: {
			limit: params.limit,
			offset: params.offset,
			with: ["participants"]
		},
		timeoutMs: params.timeoutMs
	});
	if (!res.ok) return [];
	const payload = await res.json().catch(() => null);
	const data = payload && payload.data !== void 0 ? payload.data : null;
	return Array.isArray(data) ? data : [];
}
async function fetchBlueBubblesParticipantsForInboundMessage(params) {
	if (!params.chatGuid && params.chatId == null && !params.chatIdentifier) return null;
	const limit = 500;
	for (let offset = 0; offset < 5e3; offset += limit) {
		const chats = await queryBlueBubblesChats({
			baseUrl: params.baseUrl,
			password: params.password,
			offset,
			limit,
			allowPrivateNetwork: params.allowPrivateNetwork
		});
		if (chats.length === 0) return null;
		for (const chat of chats) {
			const chatGuid = extractBlueBubblesChatGuid(chat);
			const chatId = extractBlueBubblesChatId(chat);
			const chatIdentifier = extractBlueBubblesChatIdentifier(chat);
			if (params.chatGuid && chatGuid === params.chatGuid || params.chatId != null && chatId === params.chatId || params.chatIdentifier && (chatIdentifier === params.chatIdentifier || chatGuid === params.chatIdentifier)) return normalizeParticipantList(chat);
		}
		if (chats.length < limit) return null;
	}
	return null;
}
function isBlueBubblesSelfChatMessage(message, isGroup) {
	if (isGroup || !message.senderIdExplicit) return false;
	const chatHandle = (message.chatGuid ? extractHandleFromChatGuid(message.chatGuid) : null) ?? normalizeBlueBubblesHandle(message.chatIdentifier ?? "");
	return Boolean(chatHandle) && chatHandle === message.senderId;
}
function prunePendingOutboundMessageIds(now = Date.now()) {
	const cutoff = now - PENDING_OUTBOUND_MESSAGE_ID_TTL_MS;
	for (let i = pendingOutboundMessageIds.length - 1; i >= 0; i--) if (pendingOutboundMessageIds[i].createdAt < cutoff) pendingOutboundMessageIds.splice(i, 1);
}
function rememberPendingOutboundMessageId(entry) {
	prunePendingOutboundMessageIds();
	pendingOutboundMessageIdCounter += 1;
	const snippetRaw = entry.snippet.trim();
	const snippetNorm = normalizeSnippet(snippetRaw);
	pendingOutboundMessageIds.push({
		id: pendingOutboundMessageIdCounter,
		accountId: entry.accountId,
		sessionKey: entry.sessionKey,
		outboundTarget: entry.outboundTarget,
		chatGuid: normalizeOptionalString(entry.chatGuid),
		chatIdentifier: normalizeOptionalString(entry.chatIdentifier),
		chatId: typeof entry.chatId === "number" ? entry.chatId : void 0,
		snippetRaw,
		snippetNorm,
		isMediaSnippet: normalizeLowercaseStringOrEmpty(snippetRaw).startsWith("<media:"),
		createdAt: Date.now()
	});
	return pendingOutboundMessageIdCounter;
}
function forgetPendingOutboundMessageId(id) {
	const index = pendingOutboundMessageIds.findIndex((entry) => entry.id === id);
	if (index >= 0) pendingOutboundMessageIds.splice(index, 1);
}
function chatsMatch(left, right) {
	const leftGuid = normalizeOptionalString(left.chatGuid);
	const rightGuid = normalizeOptionalString(right.chatGuid);
	if (leftGuid && rightGuid) return leftGuid === rightGuid;
	const leftIdentifier = normalizeOptionalString(left.chatIdentifier);
	const rightIdentifier = normalizeOptionalString(right.chatIdentifier);
	if (leftIdentifier && rightIdentifier) return leftIdentifier === rightIdentifier;
	const leftChatId = typeof left.chatId === "number" ? left.chatId : void 0;
	const rightChatId = typeof right.chatId === "number" ? right.chatId : void 0;
	if (leftChatId !== void 0 && rightChatId !== void 0) return leftChatId === rightChatId;
	return false;
}
function consumePendingOutboundMessageId(params) {
	prunePendingOutboundMessageIds();
	const bodyNorm = normalizeSnippet(params.body);
	const isMediaBody = normalizeLowercaseStringOrEmpty(params.body).startsWith("<media:");
	for (let i = 0; i < pendingOutboundMessageIds.length; i++) {
		const entry = pendingOutboundMessageIds[i];
		if (entry.accountId !== params.accountId) continue;
		if (!chatsMatch(entry, params)) continue;
		if (entry.snippetNorm && entry.snippetNorm === bodyNorm) {
			pendingOutboundMessageIds.splice(i, 1);
			return entry;
		}
		if (entry.isMediaSnippet && isMediaBody) {
			pendingOutboundMessageIds.splice(i, 1);
			return entry;
		}
	}
	return null;
}
function logVerbose(core, runtime, message) {
	if (core.logging.shouldLogVerbose()) runtime.log?.(`[bluebubbles] ${message}`);
}
/**
* Builds the fallback target used to look up a chatGuid when an inbound
* webhook arrives without one.
*
* Critically, group inbounds that lack every chat identifier (chatGuid /
* chatId / chatIdentifier all missing) MUST NOT fall through to the
* sender's handle. Resolving a group via the sender handle yields that
* sender's DM chatGuid, which then poisons every downstream action keyed
* off it: ack reactions land in the DM, the read receipt marks the DM,
* and the outbound reply cache stores the wrong chat — so a later short
* id resolved against that cache cannot detect the cross-chat reuse and
* the agent's react/reply silently target the DM instead of the group.
*
* Returns null in that unresolvable group case so the caller can skip
* actions that need a chatGuid rather than acting on a wrong one. DMs
* always resolve via the sender handle (the chat is, by definition, the
* conversation with that handle).
*/
function buildBlueBubblesInboundChatResolveTarget(params) {
	if (params.isGroup) {
		if (typeof params.chatId === "number" && Number.isFinite(params.chatId)) return {
			kind: "chat_id",
			chatId: params.chatId
		};
		const trimmedIdentifier = params.chatIdentifier?.trim();
		if (trimmedIdentifier) return {
			kind: "chat_identifier",
			chatIdentifier: trimmedIdentifier
		};
		return null;
	}
	const trimmedSender = params.senderId.trim();
	if (!trimmedSender) return null;
	return {
		kind: "handle",
		address: trimmedSender
	};
}
function logGroupAllowlistHint(params) {
	const log = params.runtime.log ?? console.log;
	const nameHint = params.chatName ? ` (group name: ${params.chatName})` : "";
	const accountHint = params.accountId ? ` (or channels.bluebubbles.accounts.${params.accountId}.groupAllowFrom)` : "";
	if (params.entry) {
		log(`[bluebubbles] group message blocked (${params.reason}). Allow this group by adding "${params.entry}" to channels.bluebubbles.groupAllowFrom${nameHint}.`);
		log(`[bluebubbles] add to config: channels.bluebubbles.groupAllowFrom=["${params.entry}"]${accountHint}.`);
		return;
	}
	log(`[bluebubbles] group message blocked (${params.reason}). Allow groups by setting channels.bluebubbles.groupPolicy="open" or adding a group id to channels.bluebubbles.groupAllowFrom${accountHint}${nameHint}.`);
}
function resolveBlueBubblesAckReaction(params) {
	const raw = resolveAckReaction(params.cfg, params.agentId).trim();
	if (!raw) return null;
	try {
		normalizeBlueBubblesReactionInputStrict(raw);
		return raw;
	} catch {
		const key = normalizeLowercaseStringOrEmpty(raw);
		if (!invalidAckReactions.has(key)) {
			invalidAckReactions.add(key);
			logVerbose(params.core, params.runtime, `ack reaction skipped (unsupported for BlueBubbles): ${raw}`);
		}
		return null;
	}
}
/**
* In-memory rolling history map keyed by account + chat identifier.
* Populated from incoming messages during the session.
* API backfill is attempted until one fetch resolves (or retries are exhausted).
*/
const chatHistories = /* @__PURE__ */ new Map();
const historyBackfills = /* @__PURE__ */ new Map();
const HISTORY_BACKFILL_BASE_DELAY_MS = 5e3;
const HISTORY_BACKFILL_MAX_DELAY_MS = 120 * 1e3;
const HISTORY_BACKFILL_MAX_ATTEMPTS = 6;
const HISTORY_BACKFILL_RETRY_WINDOW_MS = 1800 * 1e3;
const MAX_STORED_HISTORY_ENTRY_CHARS = 2e3;
const MAX_INBOUND_HISTORY_ENTRY_CHARS = 1200;
const MAX_INBOUND_HISTORY_TOTAL_CHARS = 12e3;
function buildAccountScopedHistoryKey(accountId, historyIdentifier) {
	return `${accountId}\u0000${historyIdentifier}`;
}
function historyDedupKey(entry) {
	const messageId = entry.messageId?.trim();
	if (messageId) return `id:${messageId}`;
	return `fallback:${entry.sender}\u0000${entry.body}\u0000${entry.timestamp ?? ""}`;
}
function truncateHistoryBody(body, maxChars) {
	const trimmed = body.trim();
	if (!trimmed) return "";
	if (trimmed.length <= maxChars) return trimmed;
	return `${trimmed.slice(0, maxChars).trimEnd()}...`;
}
function mergeHistoryEntries(params) {
	if (params.limit <= 0) return [];
	const merged = [];
	const seen = /* @__PURE__ */ new Set();
	const appendUnique = (entry) => {
		const key = historyDedupKey(entry);
		if (seen.has(key)) return;
		seen.add(key);
		merged.push(entry);
	};
	for (const entry of params.apiEntries) appendUnique(entry);
	for (const entry of params.currentEntries) appendUnique(entry);
	if (merged.length <= params.limit) return merged;
	return merged.slice(merged.length - params.limit);
}
function pruneHistoryBackfillState() {
	for (const key of historyBackfills.keys()) if (!chatHistories.has(key)) historyBackfills.delete(key);
}
function markHistoryBackfillResolved(historyKey) {
	const state = historyBackfills.get(historyKey);
	if (state) {
		state.resolved = true;
		historyBackfills.set(historyKey, state);
		return;
	}
	historyBackfills.set(historyKey, {
		attempts: 0,
		firstAttemptAt: Date.now(),
		nextAttemptAt: Number.POSITIVE_INFINITY,
		resolved: true
	});
}
function planHistoryBackfillAttempt(historyKey, now) {
	const existing = historyBackfills.get(historyKey);
	if (existing?.resolved) return null;
	if (existing && now - existing.firstAttemptAt > HISTORY_BACKFILL_RETRY_WINDOW_MS) {
		markHistoryBackfillResolved(historyKey);
		return null;
	}
	if (existing && existing.attempts >= HISTORY_BACKFILL_MAX_ATTEMPTS) {
		markHistoryBackfillResolved(historyKey);
		return null;
	}
	if (existing && now < existing.nextAttemptAt) return null;
	const attempts = (existing?.attempts ?? 0) + 1;
	const state = {
		attempts,
		firstAttemptAt: existing?.firstAttemptAt ?? now,
		nextAttemptAt: now + Math.min(HISTORY_BACKFILL_BASE_DELAY_MS * 2 ** (attempts - 1), HISTORY_BACKFILL_MAX_DELAY_MS),
		resolved: false
	};
	historyBackfills.set(historyKey, state);
	return state;
}
function buildInboundHistorySnapshot(params) {
	if (params.limit <= 0 || params.entries.length === 0) return;
	const recent = params.entries.slice(-params.limit);
	const selected = [];
	let remainingChars = MAX_INBOUND_HISTORY_TOTAL_CHARS;
	for (let i = recent.length - 1; i >= 0; i--) {
		const entry = recent[i];
		const body = truncateHistoryBody(entry.body, MAX_INBOUND_HISTORY_ENTRY_CHARS);
		if (!body) continue;
		if (selected.length > 0 && body.length > remainingChars) break;
		selected.push({
			sender: entry.sender,
			body,
			timestamp: entry.timestamp
		});
		remainingChars -= body.length;
		if (remainingChars <= 0) break;
	}
	if (selected.length === 0) return;
	selected.reverse();
	return selected;
}
function sanitizeForLog(value, maxLen = 200) {
	let cleaned = String(value).replace(/[\r\n\t\p{C}]/gu, " ");
	cleaned = cleaned.replace(/([?&](?:password|guid|token|api[_-]?key|secret)=)[^&\s"]+/gi, "$1<redacted>");
	cleaned = cleaned.replace(/(authorization\s*:\s*(?:bearer|basic)\s+)[^\s"]+/gi, "$1<redacted>");
	return cleaned.length > maxLen ? cleaned.slice(0, maxLen) + "..." : cleaned;
}
/**
* Claim → process → finalize/release wrapper around the real inbound flow.
*
* Claim before doing any work so restart replays and in-flight concurrent
* redeliveries both drop cleanly. Finalize (persist the GUID) only when
* processing completed cleanly AND any reply dispatch reported success;
* release (let a later replay try again) when processing threw OR the reply
* pipeline reported a delivery failure via its onError callback.
*
* The dedupe key follows the same canonicalization rules as the debouncer
* (`monitor-debounce.ts`): balloon events (URL previews, stickers) share
* a logical identity with their originating text message via
* `associatedMessageGuid`, so balloon-first vs text-first event ordering
* cannot produce two distinct dedupe keys for the same logical message.
*/
async function processMessage(message, target) {
	const { account, core, runtime } = target;
	const dedupeKey = resolveBlueBubblesInboundDedupeKey(message);
	const claim = await claimBlueBubblesInboundMessage({
		guid: dedupeKey,
		accountId: account.accountId,
		onDiskError: (error) => logVerbose(core, runtime, `inbound-dedupe disk error: ${sanitizeForLog(error)}`)
	});
	if (claim.kind === "duplicate" || claim.kind === "inflight") {
		logVerbose(core, runtime, `drop: ${claim.kind} inbound key=${sanitizeForLog(dedupeKey ?? "")} sender=${sanitizeForLog(message.senderId)}`);
		return;
	}
	const signal = { deliveryFailed: false };
	try {
		await processMessageAfterDedupe(message, target, signal);
	} catch (error) {
		if (claim.kind === "claimed") claim.release();
		throw error;
	}
	if (claim.kind === "claimed") if (signal.deliveryFailed) {
		logVerbose(core, runtime, `inbound-dedupe: releasing claim for key=${sanitizeForLog(dedupeKey ?? "")} after reply delivery failure (will retry on replay)`);
		claim.release();
	} else {
		try {
			await claim.finalize();
		} catch (finalizeError) {
			logVerbose(core, runtime, `inbound-dedupe: finalize failed for key=${sanitizeForLog(dedupeKey ?? "")}: ${sanitizeForLog(finalizeError)}`);
		}
		const secondaryIds = (message.coalescedMessageIds ?? []).filter((id) => id !== dedupeKey);
		if (secondaryIds.length > 0) try {
			await commitBlueBubblesCoalescedMessageIds({
				messageIds: secondaryIds,
				accountId: account.accountId,
				onDiskError: (error) => logVerbose(core, runtime, `inbound-dedupe: coalesced secondary commit disk error: ${sanitizeForLog(error)}`)
			});
		} catch (secondaryError) {
			logVerbose(core, runtime, `inbound-dedupe: coalesced secondary commit failed for primary=${sanitizeForLog(dedupeKey ?? "")}: ${sanitizeForLog(secondaryError)}`);
		}
	}
}
async function processMessageAfterDedupe(message, target, dedupeSignal) {
	const { account, config, runtime, core, statusSink } = target;
	const pairing = createChannelPairingController({
		core,
		channel: "bluebubbles",
		accountId: account.accountId
	});
	const privateApiEnabled = isBlueBubblesPrivateApiEnabled(account.accountId);
	const groupFlag = resolveGroupFlagFromChatGuid(message.chatGuid);
	const isGroup = typeof groupFlag === "boolean" ? groupFlag : message.isGroup;
	const text = message.text.trim();
	let attachments = message.attachments ?? [];
	const baseUrl = normalizeSecretInputString(account.config.serverUrl);
	const password = normalizeSecretInputString(account.config.password);
	const retryMessageId = message.messageId?.trim();
	if (attachments.length === 0 && retryMessageId && baseUrl && password && (text.length === 0 || message.eventType === "updated-message")) try {
		await new Promise((resolve) => setTimeout(resolve, 2e3));
		const fetched = await fetchBlueBubblesMessageAttachments(retryMessageId, {
			baseUrl,
			password,
			timeoutMs: 1e4,
			allowPrivateNetwork: isPrivateNetworkOptInEnabled(account.config)
		});
		if (fetched.length > 0) {
			logVerbose(core, runtime, `attachment retry found ${fetched.length} attachment(s) for msgId=${message.messageId}`);
			attachments = fetched;
		}
	} catch (err) {
		logVerbose(core, runtime, `attachment retry failed for msgId=${sanitizeForLog(message.messageId)}: ${sanitizeForLog(err)}`);
	}
	const placeholder = buildMessagePlaceholder({
		...message,
		attachments
	});
	const tapbackContext = resolveTapbackContext(message);
	const tapbackParsed = parseTapbackText({
		text,
		emojiHint: tapbackContext?.emojiHint,
		actionHint: tapbackContext?.actionHint,
		requireQuoted: !tapbackContext
	});
	const isTapbackMessage = Boolean(tapbackParsed);
	const rawBody = tapbackParsed ? tapbackParsed.action === "removed" ? `removed ${tapbackParsed.emoji} reaction` : `reacted with ${tapbackParsed.emoji}` : text || placeholder;
	const isSelfChatMessage = isBlueBubblesSelfChatMessage(message, isGroup);
	const selfChatLookup = {
		accountId: account.accountId,
		chatGuid: message.chatGuid,
		chatIdentifier: message.chatIdentifier,
		chatId: message.chatId,
		senderId: message.senderId,
		body: rawBody,
		timestamp: message.timestamp
	};
	const cacheMessageId = message.messageId?.trim();
	const confirmedOutboundCacheEntry = cacheMessageId ? resolveReplyContextFromCache({
		accountId: account.accountId,
		replyToId: cacheMessageId,
		chatGuid: message.chatGuid,
		chatIdentifier: message.chatIdentifier,
		chatId: message.chatId
	}) : null;
	let messageShortId;
	const cacheInboundMessage = () => {
		if (!cacheMessageId) return;
		messageShortId = rememberBlueBubblesReplyCache({
			accountId: account.accountId,
			messageId: cacheMessageId,
			chatGuid: message.chatGuid,
			chatIdentifier: message.chatIdentifier,
			chatId: message.chatId,
			senderLabel: message.fromMe ? "me" : message.senderId,
			body: rawBody,
			timestamp: message.timestamp ?? Date.now()
		}).shortId;
	};
	if (message.fromMe) {
		cacheInboundMessage();
		const confirmedAssistantOutbound = confirmedOutboundCacheEntry?.senderLabel === "me" && normalizeSnippet(confirmedOutboundCacheEntry.body ?? "") === normalizeSnippet(rawBody);
		if (isSelfChatMessage && confirmedAssistantOutbound) rememberBlueBubblesSelfChatCopy(selfChatLookup);
		if (cacheMessageId) {
			const pending = consumePendingOutboundMessageId({
				accountId: account.accountId,
				chatGuid: message.chatGuid,
				chatIdentifier: message.chatIdentifier,
				chatId: message.chatId,
				body: rawBody
			});
			if (pending) {
				const displayId = getShortIdForUuid(cacheMessageId) || cacheMessageId;
				const previewSource = pending.snippetRaw || rawBody;
				const preview = previewSource ? ` "${previewSource.slice(0, 12)}${previewSource.length > 12 ? "…" : ""}"` : "";
				core.system.enqueueSystemEvent(`Assistant sent${preview} [message_id:${displayId}]`, {
					sessionKey: pending.sessionKey,
					contextKey: `bluebubbles:outbound:${pending.outboundTarget}:${cacheMessageId}`
				});
			}
		}
		return;
	}
	if (isSelfChatMessage && hasBlueBubblesSelfChatCopy(selfChatLookup)) {
		logVerbose(core, runtime, `drop: reflected self-chat duplicate sender=${sanitizeForLog(message.senderId)}`);
		return;
	}
	if (!rawBody) {
		logVerbose(core, runtime, `drop: empty text sender=${sanitizeForLog(message.senderId)}`);
		return;
	}
	logVerbose(core, runtime, `msg sender=${sanitizeForLog(message.senderId)} group=${isGroup} textLen=${text.length} attachments=${attachments.length} chatGuid=${sanitizeForLog(message.chatGuid ?? "")} chatId=${sanitizeForLog(message.chatId ?? "")}`);
	const dmPolicy = account.config.dmPolicy ?? "pairing";
	const groupPolicy = account.config.groupPolicy ?? "allowlist";
	const configuredAllowFrom = mapAllowFromEntries(account.config.allowFrom);
	const storeAllowFrom = await readStoreAllowFromForDmPolicy({
		provider: "bluebubbles",
		accountId: account.accountId,
		dmPolicy,
		readStore: pairing.readStoreForDmPolicy
	});
	const accessDecision = resolveDmGroupAccessWithLists({
		isGroup,
		dmPolicy,
		groupPolicy,
		allowFrom: configuredAllowFrom,
		groupAllowFrom: account.config.groupAllowFrom,
		storeAllowFrom,
		isSenderAllowed: (allowFrom) => isAllowedBlueBubblesSender({
			allowFrom,
			sender: message.senderId,
			chatId: message.chatId ?? void 0,
			chatGuid: message.chatGuid ?? void 0,
			chatIdentifier: message.chatIdentifier ?? void 0
		})
	});
	const effectiveAllowFrom = accessDecision.effectiveAllowFrom;
	const effectiveGroupAllowFrom = accessDecision.effectiveGroupAllowFrom;
	const groupAllowEntry = formatGroupAllowlistEntry({
		chatGuid: message.chatGuid,
		chatId: message.chatId ?? void 0,
		chatIdentifier: message.chatIdentifier ?? void 0
	});
	const groupName = normalizeOptionalString(message.chatName);
	if (accessDecision.decision !== "allow") {
		if (isGroup) {
			if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_DISABLED) {
				logVerbose(core, runtime, "Blocked BlueBubbles group message (groupPolicy=disabled)");
				logGroupAllowlistHint({
					runtime,
					reason: "groupPolicy=disabled",
					entry: groupAllowEntry,
					chatName: groupName,
					accountId: account.accountId
				});
				return;
			}
			if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_EMPTY_ALLOWLIST) {
				logVerbose(core, runtime, "Blocked BlueBubbles group message (no allowlist)");
				logGroupAllowlistHint({
					runtime,
					reason: "groupPolicy=allowlist (empty allowlist)",
					entry: groupAllowEntry,
					chatName: groupName,
					accountId: account.accountId
				});
				return;
			}
			if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_NOT_ALLOWLISTED) {
				logVerbose(core, runtime, `Blocked BlueBubbles sender ${message.senderId} (not in groupAllowFrom)`);
				logVerbose(core, runtime, `drop: group sender not allowed sender=${message.senderId} allowFrom=${effectiveGroupAllowFrom.join(",")}`);
				logGroupAllowlistHint({
					runtime,
					reason: "groupPolicy=allowlist (not allowlisted)",
					entry: groupAllowEntry,
					chatName: groupName,
					accountId: account.accountId
				});
				return;
			}
			return;
		}
		if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.DM_POLICY_DISABLED) {
			logVerbose(core, runtime, `Blocked BlueBubbles DM from ${message.senderId}`);
			logVerbose(core, runtime, `drop: dmPolicy disabled sender=${message.senderId}`);
			return;
		}
		if (accessDecision.decision === "pairing") {
			await pairing.issueChallenge({
				senderId: message.senderId,
				senderIdLine: `Your BlueBubbles sender id: ${message.senderId}`,
				meta: { name: message.senderName },
				onCreated: () => {
					runtime.log?.(`[bluebubbles] pairing request sender=${sanitizeForLog(message.senderId)} created=true`);
					logVerbose(core, runtime, `bluebubbles pairing request sender=${sanitizeForLog(message.senderId)}`);
				},
				sendPairingReply: async (text) => {
					await sendMessageBlueBubbles(message.senderId, text, {
						cfg: config,
						accountId: account.accountId
					});
					statusSink?.({ lastOutboundAt: Date.now() });
				},
				onReplyError: (err) => {
					logVerbose(core, runtime, `bluebubbles pairing reply failed for ${sanitizeForLog(message.senderId)}: ${sanitizeForLog(err)}`);
					runtime.error?.(`[bluebubbles] pairing reply failed sender=${sanitizeForLog(message.senderId)}: ${sanitizeForLog(err)}`);
				}
			});
			return;
		}
		logVerbose(core, runtime, `Blocked unauthorized BlueBubbles sender ${message.senderId} (dmPolicy=${dmPolicy})`);
		logVerbose(core, runtime, `drop: dm sender not allowed sender=${message.senderId} allowFrom=${effectiveAllowFrom.join(",")}`);
		return;
	}
	const chatId = message.chatId ?? void 0;
	const chatGuid = message.chatGuid ?? void 0;
	const chatIdentifier = message.chatIdentifier ?? void 0;
	const peerId = isGroup ? chatGuid ?? chatIdentifier ?? (chatId ? String(chatId) : "group") : message.senderId;
	const route = resolveBlueBubblesConversationRoute({
		cfg: config,
		accountId: account.accountId,
		isGroup,
		peerId,
		sender: message.senderId,
		chatId,
		chatGuid,
		chatIdentifier
	});
	const contextVisibilityMode = resolveChannelContextVisibilityMode({
		cfg: config,
		channel: "bluebubbles",
		accountId: account.accountId
	});
	const messageText = text;
	const mentionRegexes = core.channel.mentions.buildMentionRegexes(config, route.agentId);
	const wasMentioned = isGroup ? core.channel.mentions.matchesMentionPatterns(messageText, mentionRegexes) : true;
	const canDetectMention = mentionRegexes.length > 0;
	const requireMention = core.channel.groups.resolveRequireMention({
		cfg: config,
		channel: "bluebubbles",
		groupId: peerId,
		accountId: account.accountId
	});
	const useAccessGroups = config.commands?.useAccessGroups !== false;
	const hasControlCmd = core.channel.text.hasControlCommand(messageText, config);
	const commandDmAllowFrom = isGroup ? configuredAllowFrom : effectiveAllowFrom;
	const ownerAllowedForCommands = commandDmAllowFrom.length > 0 ? isAllowedBlueBubblesSender({
		allowFrom: commandDmAllowFrom,
		sender: message.senderId,
		chatId: message.chatId ?? void 0,
		chatGuid: message.chatGuid ?? void 0,
		chatIdentifier: message.chatIdentifier ?? void 0
	}) : false;
	const groupAllowedForCommands = effectiveGroupAllowFrom.length > 0 ? isAllowedBlueBubblesSender({
		allowFrom: effectiveGroupAllowFrom,
		sender: message.senderId,
		chatId: message.chatId ?? void 0,
		chatGuid: message.chatGuid ?? void 0,
		chatIdentifier: message.chatIdentifier ?? void 0
	}) : false;
	const commandGate = resolveControlCommandGate({
		useAccessGroups,
		authorizers: [{
			configured: commandDmAllowFrom.length > 0,
			allowed: ownerAllowedForCommands
		}, {
			configured: effectiveGroupAllowFrom.length > 0,
			allowed: groupAllowedForCommands
		}],
		allowTextCommands: true,
		hasControlCommand: hasControlCmd
	});
	const commandAuthorized = commandGate.commandAuthorized;
	if (isGroup && commandGate.shouldBlock) {
		logInboundDrop({
			log: (msg) => logVerbose(core, runtime, msg),
			channel: "bluebubbles",
			reason: "control command (unauthorized)",
			target: message.senderId
		});
		return;
	}
	const shouldBypassMention = isGroup && requireMention && !wasMentioned && commandAuthorized && hasControlCmd;
	const effectiveWasMentioned = wasMentioned || shouldBypassMention;
	if (isGroup && requireMention && canDetectMention && !wasMentioned && !shouldBypassMention) {
		logVerbose(core, runtime, `bluebubbles: skipping group message (no mention)`);
		return;
	}
	if (isGroup && !message.participants?.length && baseUrl && password) try {
		const fetchedParticipants = await fetchBlueBubblesParticipantsForInboundMessage({
			baseUrl,
			password,
			chatGuid: message.chatGuid,
			chatId: message.chatId,
			chatIdentifier: message.chatIdentifier,
			allowPrivateNetwork: isPrivateNetworkOptInEnabled(account.config)
		});
		if (fetchedParticipants?.length) message.participants = fetchedParticipants;
	} catch (err) {
		logVerbose(core, runtime, `bluebubbles: participant fallback lookup failed chat=${sanitizeForLog(peerId)}: ${sanitizeForLog(err)}`);
	}
	if (isGroup && account.config.enrichGroupParticipantsFromContacts === true && message.participants?.length) message.participants = await enrichBlueBubblesParticipantsWithContactNames(message.participants);
	cacheInboundMessage();
	const maxBytes = account.config.mediaMaxMb && account.config.mediaMaxMb > 0 ? account.config.mediaMaxMb * 1024 * 1024 : 8 * 1024 * 1024;
	let mediaUrls = [];
	let mediaPaths = [];
	let mediaTypes = [];
	if (attachments.length > 0) if (!baseUrl || !password) logVerbose(core, runtime, "attachment download skipped (missing serverUrl/password)");
	else for (const attachment of attachments) {
		if (!attachment.guid) continue;
		if (attachment.totalBytes && attachment.totalBytes > maxBytes) {
			logVerbose(core, runtime, `attachment too large guid=${attachment.guid} bytes=${attachment.totalBytes}`);
			continue;
		}
		try {
			const downloaded = await downloadBlueBubblesAttachment(attachment, {
				cfg: config,
				accountId: account.accountId,
				maxBytes
			});
			const saved = await core.channel.media.saveMediaBuffer(Buffer.from(downloaded.buffer), downloaded.contentType, "inbound", maxBytes);
			mediaPaths.push(saved.path);
			mediaUrls.push(saved.path);
			if (saved.contentType) mediaTypes.push(saved.contentType);
		} catch (err) {
			const safeGuid = sanitizeForLog(attachment.guid, 80);
			const safeErr = sanitizeForLog(err);
			runtime.error?.(`[bluebubbles] attachment download failed guid=${safeGuid} err=${safeErr}`);
			logVerbose(core, runtime, `attachment download failed guid=${safeGuid} err=${safeErr}`);
		}
	}
	let replyToId = message.replyToId;
	let replyToBody = message.replyToBody;
	let replyToSender = message.replyToSender;
	let replyToShortId;
	if (isTapbackMessage && tapbackContext?.replyToId) replyToId = tapbackContext.replyToId;
	if (replyToId) {
		const cached = resolveReplyContextFromCache({
			accountId: account.accountId,
			replyToId,
			chatGuid: message.chatGuid,
			chatIdentifier: message.chatIdentifier,
			chatId: message.chatId
		});
		if (cached) {
			if (!replyToBody && cached.body) replyToBody = cached.body;
			if (!replyToSender && cached.senderLabel) replyToSender = cached.senderLabel;
			replyToShortId = cached.shortId;
			if (core.logging.shouldLogVerbose()) {
				const preview = (cached.body ?? "").replace(/\s+/g, " ").slice(0, 120);
				logVerbose(core, runtime, `reply-context cache hit replyToId=${replyToId} sender=${replyToSender ?? ""} body="${preview}"`);
			}
		}
	}
	if (replyToId && (!replyToBody || !replyToSender) && baseUrl && password && account.config.replyContextApiFallback === true) {
		const fetched = await fetchBlueBubblesReplyContext({
			accountId: account.accountId,
			replyToId,
			baseUrl,
			password,
			accountConfig: account.config,
			chatGuid: message.chatGuid,
			chatIdentifier: message.chatIdentifier,
			chatId: message.chatId
		});
		if (fetched) {
			if (!replyToBody && fetched.body) replyToBody = fetched.body;
			if (!replyToSender && fetched.sender) replyToSender = fetched.sender;
			if (core.logging.shouldLogVerbose()) {
				const preview = sanitizeForLog((fetched.body ?? "").replace(/\s+/g, " "), 120);
				logVerbose(core, runtime, `reply-context API fallback replyToId=${sanitizeForLog(replyToId)} sender=${sanitizeForLog(fetched.sender ?? "")} body="${preview}"`);
			}
		}
	}
	if (replyToId && !replyToShortId) replyToShortId = getShortIdForUuid(replyToId);
	const hasReplyContext = Boolean(replyToId || replyToBody || replyToSender);
	const replySenderAllowed = !isGroup || effectiveGroupAllowFrom.length === 0 ? true : replyToSender ? isAllowedBlueBubblesSender({
		allowFrom: effectiveGroupAllowFrom,
		sender: replyToSender,
		chatId: message.chatId ?? void 0,
		chatGuid: message.chatGuid ?? void 0,
		chatIdentifier: message.chatIdentifier ?? void 0
	}) : false;
	const includeReplyContext = !hasReplyContext || evaluateSupplementalContextVisibility({
		mode: contextVisibilityMode,
		kind: "quote",
		senderAllowed: replySenderAllowed
	}).include;
	if (hasReplyContext && !includeReplyContext && isGroup) logVerbose(core, runtime, `bluebubbles: drop reply context (mode=${contextVisibilityMode}, sender_allowed=${replySenderAllowed ? "yes" : "no"})`);
	const visibleReplyToId = includeReplyContext ? replyToId : void 0;
	const visibleReplyToShortId = includeReplyContext ? replyToShortId : void 0;
	const visibleReplyToBody = includeReplyContext ? replyToBody : void 0;
	const visibleReplyToSender = includeReplyContext ? replyToSender : void 0;
	const replyTag = formatReplyTag({
		replyToId: visibleReplyToId,
		replyToShortId: visibleReplyToShortId
	});
	const baseBody = replyTag ? isTapbackMessage ? `${rawBody} ${replyTag}` : `${replyTag} ${rawBody}` : rawBody;
	const senderLabel = message.senderName || `user:${message.senderId}`;
	const fromLabel = isGroup ? `${normalizeOptionalString(message.chatName) || "Group"} id:${peerId}` : senderLabel !== message.senderId ? `${senderLabel} id:${message.senderId}` : senderLabel;
	const groupSubject = isGroup ? normalizeOptionalString(message.chatName) : void 0;
	const groupMembers = isGroup ? formatGroupMembers({
		participants: message.participants,
		fallback: message.senderId ? {
			id: message.senderId,
			name: message.senderName
		} : void 0
	}) : void 0;
	const storePath = core.channel.session.resolveStorePath(config.session?.store, { agentId: route.agentId });
	const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
	const previousTimestamp = core.channel.session.readSessionUpdatedAt({
		storePath,
		sessionKey: route.sessionKey
	});
	const body = core.channel.reply.formatInboundEnvelope({
		channel: "BlueBubbles",
		from: fromLabel,
		timestamp: message.timestamp,
		previousTimestamp,
		envelope: envelopeOptions,
		body: baseBody,
		chatType: isGroup ? "group" : "direct",
		sender: {
			name: message.senderName || void 0,
			id: message.senderId
		}
	});
	let chatGuidForActions = chatGuid;
	if (!chatGuidForActions && baseUrl && password) {
		const resolveTarget = buildBlueBubblesInboundChatResolveTarget({
			isGroup,
			chatId,
			chatIdentifier,
			senderId: message.senderId
		});
		if (resolveTarget) chatGuidForActions = await resolveChatGuidForTarget({
			baseUrl,
			password,
			target: resolveTarget,
			allowPrivateNetwork: isPrivateNetworkOptInEnabled(account.config)
		}) ?? void 0;
		else logVerbose(core, runtime, `cannot resolve chatGuid for group inbound (chatGuid/chatId/chatIdentifier all missing); senderId=${sanitizeForLog(message.senderId)}`);
	}
	const ackReactionScope = config.messages?.ackReactionScope ?? "group-mentions";
	const removeAckAfterReply = config.messages?.removeAckAfterReply ?? false;
	const ackReactionValue = resolveBlueBubblesAckReaction({
		cfg: config,
		agentId: route.agentId,
		core,
		runtime
	});
	const shouldAckReaction = () => Boolean(ackReactionValue && core.channel.reactions.shouldAckReaction({
		scope: ackReactionScope,
		isDirect: !isGroup,
		isGroup,
		isMentionableGroup: isGroup,
		requireMention,
		canDetectMention,
		effectiveWasMentioned,
		shouldBypassMention
	}));
	const ackMessageId = message.messageId?.trim() || "";
	const ackReactionPromise = shouldAckReaction() && ackMessageId && chatGuidForActions && ackReactionValue ? sendBlueBubblesReaction({
		chatGuid: chatGuidForActions,
		messageGuid: ackMessageId,
		emoji: ackReactionValue,
		opts: {
			cfg: config,
			accountId: account.accountId
		}
	}).then(() => true, (err) => {
		logVerbose(core, runtime, `ack reaction failed chatGuid=${sanitizeForLog(chatGuidForActions)} msg=${sanitizeForLog(ackMessageId)}: ${sanitizeForLog(err)}`);
		return false;
	}) : null;
	const sendReadReceipts = account.config.sendReadReceipts !== false;
	if (chatGuidForActions && baseUrl && password && sendReadReceipts) try {
		await markBlueBubblesChatRead(chatGuidForActions, {
			cfg: config,
			accountId: account.accountId
		});
		logVerbose(core, runtime, `marked read chatGuid=${sanitizeForLog(chatGuidForActions)}`);
	} catch (err) {
		runtime.error?.(`[bluebubbles] mark read failed: ${sanitizeForLog(err)}`);
	}
	else if (!sendReadReceipts) logVerbose(core, runtime, "mark read skipped (sendReadReceipts=false)");
	else logVerbose(core, runtime, "mark read skipped (missing chatGuid or credentials)");
	const outboundTarget = isGroup ? formatBlueBubblesChatTarget({
		chatId,
		chatGuid: chatGuidForActions ?? chatGuid,
		chatIdentifier
	}) || peerId : chatGuidForActions ? formatBlueBubblesChatTarget({ chatGuid: chatGuidForActions }) : message.senderId;
	const maybeEnqueueOutboundMessageId = (messageId, snippet) => {
		const trimmed = messageId?.trim();
		if (!trimmed || trimmed === "ok" || trimmed === "unknown") return false;
		const displayId = rememberBlueBubblesReplyCache({
			accountId: account.accountId,
			messageId: trimmed,
			chatGuid: chatGuidForActions ?? chatGuid,
			chatIdentifier,
			chatId,
			senderLabel: "me",
			body: snippet ?? "",
			timestamp: Date.now()
		}).shortId || trimmed;
		const preview = snippet ? ` "${snippet.slice(0, 12)}${snippet.length > 12 ? "…" : ""}"` : "";
		core.system.enqueueSystemEvent(`Assistant sent${preview} [message_id:${displayId}]`, {
			sessionKey: route.sessionKey,
			contextKey: `bluebubbles:outbound:${outboundTarget}:${trimmed}`
		});
		return true;
	};
	const sanitizeReplyDirectiveText = (value) => {
		if (privateApiEnabled) return value;
		return value.replace(REPLY_DIRECTIVE_TAG_RE, " ").replace(/[ \t]+/g, " ").trim();
	};
	const historyLimit = isGroup ? account.config.historyLimit ?? 0 : account.config.dmHistoryLimit ?? 0;
	const historyIdentifier = chatGuid || chatIdentifier || (chatId ? String(chatId) : null) || (isGroup ? null : message.senderId) || "";
	const historyKey = historyIdentifier ? buildAccountScopedHistoryKey(account.accountId, historyIdentifier) : "";
	if (historyKey && historyLimit > 0) {
		const nowMs = Date.now();
		const senderLabel = message.fromMe ? "me" : message.senderName || message.senderId;
		const normalizedHistoryBody = truncateHistoryBody(text, MAX_STORED_HISTORY_ENTRY_CHARS);
		const currentEntries = recordPendingHistoryEntryIfEnabled({
			historyMap: chatHistories,
			limit: historyLimit,
			historyKey,
			entry: normalizedHistoryBody ? {
				sender: senderLabel,
				body: normalizedHistoryBody,
				timestamp: message.timestamp ?? nowMs,
				messageId: message.messageId ?? void 0
			} : null
		});
		pruneHistoryBackfillState();
		const backfillAttempt = planHistoryBackfillAttempt(historyKey, nowMs);
		if (backfillAttempt) try {
			const backfillResult = await fetchBlueBubblesHistory(historyIdentifier, historyLimit, {
				cfg: config,
				accountId: account.accountId
			});
			if (backfillResult.resolved) markHistoryBackfillResolved(historyKey);
			if (backfillResult.entries.length > 0) {
				const apiEntries = [];
				for (const entry of backfillResult.entries) {
					const body = truncateHistoryBody(entry.body, MAX_STORED_HISTORY_ENTRY_CHARS);
					if (!body) continue;
					apiEntries.push({
						sender: entry.sender,
						body,
						timestamp: entry.timestamp,
						messageId: entry.messageId
					});
				}
				const merged = mergeHistoryEntries({
					apiEntries,
					currentEntries: currentEntries.length > 0 ? currentEntries : chatHistories.get(historyKey) ?? [],
					limit: historyLimit
				});
				if (chatHistories.has(historyKey)) chatHistories.delete(historyKey);
				chatHistories.set(historyKey, merged);
				evictOldHistoryKeys(chatHistories);
				logVerbose(core, runtime, `backfilled ${backfillResult.entries.length} history messages for ${isGroup ? "group" : "DM"}: ${historyIdentifier}`);
			} else if (!backfillResult.resolved) {
				const remainingAttempts = HISTORY_BACKFILL_MAX_ATTEMPTS - backfillAttempt.attempts;
				const nextBackoffMs = Math.max(backfillAttempt.nextAttemptAt - nowMs, 0);
				logVerbose(core, runtime, `history backfill unresolved for ${historyIdentifier}; retries left=${Math.max(remainingAttempts, 0)} next_in_ms=${nextBackoffMs}`);
			}
		} catch (err) {
			const remainingAttempts = HISTORY_BACKFILL_MAX_ATTEMPTS - backfillAttempt.attempts;
			const nextBackoffMs = Math.max(backfillAttempt.nextAttemptAt - nowMs, 0);
			logVerbose(core, runtime, `history backfill failed for ${sanitizeForLog(historyIdentifier)}: ${sanitizeForLog(err)} (retries left=${Math.max(remainingAttempts, 0)} next_in_ms=${nextBackoffMs})`);
		}
	}
	let inboundHistory;
	if (historyKey && historyLimit > 0) {
		const entries = chatHistories.get(historyKey);
		if (entries && entries.length > 0) inboundHistory = buildInboundHistorySnapshot({
			entries,
			limit: historyLimit
		});
	}
	const commandBody = messageText.trim();
	const ctxPayload = core.channel.reply.finalizeInboundContext({
		Body: body,
		BodyForAgent: rawBody,
		InboundHistory: inboundHistory,
		RawBody: rawBody,
		CommandBody: commandBody,
		BodyForCommands: commandBody,
		MediaUrl: mediaUrls[0],
		MediaUrls: mediaUrls.length > 0 ? mediaUrls : void 0,
		MediaPath: mediaPaths[0],
		MediaPaths: mediaPaths.length > 0 ? mediaPaths : void 0,
		MediaType: mediaTypes[0],
		MediaTypes: mediaTypes.length > 0 ? mediaTypes : void 0,
		From: isGroup ? `group:${peerId}` : `bluebubbles:${message.senderId}`,
		To: `bluebubbles:${outboundTarget}`,
		SessionKey: route.sessionKey,
		AccountId: route.accountId,
		ChatType: isGroup ? "group" : "direct",
		ConversationLabel: fromLabel,
		ReplyToId: visibleReplyToShortId || visibleReplyToId,
		ReplyToIdFull: visibleReplyToId,
		ReplyToBody: visibleReplyToBody,
		ReplyToSender: visibleReplyToSender,
		GroupSubject: groupSubject,
		GroupMembers: groupMembers,
		SenderName: message.senderName || void 0,
		SenderId: message.senderId,
		Provider: "bluebubbles",
		Surface: "bluebubbles",
		MessageSid: messageShortId || message.messageId,
		MessageSidFull: message.messageId,
		Timestamp: message.timestamp,
		OriginatingChannel: "bluebubbles",
		OriginatingTo: `bluebubbles:${outboundTarget}`,
		WasMentioned: effectiveWasMentioned,
		CommandAuthorized: commandAuthorized,
		GroupSystemPrompt: isGroup ? normalizeOptionalString(account.config.groups?.[peerId]?.systemPrompt ?? account.config.groups?.["*"]?.systemPrompt) : void 0
	});
	let sentMessage = false;
	let streamingActive = false;
	let typingRestartTimer;
	const typingRestartDelayMs = 150;
	const clearTypingRestartTimer = () => {
		if (typingRestartTimer) {
			clearTimeout(typingRestartTimer);
			typingRestartTimer = void 0;
		}
	};
	const restartTypingSoon = () => {
		if (!streamingActive || !chatGuidForActions || !baseUrl || !password) return;
		clearTypingRestartTimer();
		typingRestartTimer = setTimeout(() => {
			typingRestartTimer = void 0;
			if (!streamingActive) return;
			sendBlueBubblesTyping(chatGuidForActions, true, {
				cfg: config,
				accountId: account.accountId
			}).catch((err) => {
				runtime.error?.(`[bluebubbles] typing restart failed: ${sanitizeForLog(err)}`);
			});
		}, typingRestartDelayMs);
	};
	try {
		const { onModelSelected, typingCallbacks, ...replyPipeline } = createChannelReplyPipeline({
			cfg: config,
			agentId: route.agentId,
			channel: "bluebubbles",
			accountId: account.accountId,
			typingCallbacks: {
				onReplyStart: async () => {
					if (!chatGuidForActions) return;
					if (!baseUrl || !password) return;
					streamingActive = true;
					clearTypingRestartTimer();
					try {
						await sendBlueBubblesTyping(chatGuidForActions, true, {
							cfg: config,
							accountId: account.accountId
						});
					} catch (err) {
						runtime.error?.(`[bluebubbles] typing start failed: ${sanitizeForLog(err)}`);
					}
				},
				onIdle: () => {
					if (!chatGuidForActions) return;
					if (!baseUrl || !password) return;
				}
			}
		});
		await core.channel.turn.run({
			channel: "bluebubbles",
			accountId: account.accountId,
			raw: ctxPayload,
			adapter: {
				ingest: () => ({
					id: String(ctxPayload.MessageSid ?? message.messageId),
					timestamp: message.timestamp,
					rawText: rawBody,
					textForAgent: rawBody,
					textForCommands: commandBody,
					raw: ctxPayload
				}),
				resolveTurn: () => ({
					cfg: config,
					channel: "bluebubbles",
					accountId: account.accountId,
					agentId: route.agentId,
					routeSessionKey: route.sessionKey,
					storePath,
					ctxPayload,
					recordInboundSession: core.channel.session.recordInboundSession,
					dispatchReplyWithBufferedBlockDispatcher: core.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
					delivery: {
						deliver: async (payload, info) => {
							const rawReplyToId = privateApiEnabled && typeof payload.replyToId === "string" ? payload.replyToId.trim() : "";
							const replyToMessageGuid = rawReplyToId ? resolveBlueBubblesMessageId(rawReplyToId, {
								requireKnownShortId: true,
								chatContext: {
									chatGuid: chatGuidForActions ?? chatGuid,
									chatIdentifier,
									chatId
								}
							}) : "";
							const mediaList = resolveOutboundMediaUrls(payload);
							if (mediaList.length > 0) {
								const tableMode = core.channel.text.resolveMarkdownTableMode({
									cfg: config,
									channel: "bluebubbles",
									accountId: account.accountId
								});
								await sendMediaWithLeadingCaption({
									mediaUrls: mediaList,
									caption: sanitizeReplyDirectiveText(core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode)),
									send: async ({ mediaUrl, caption }) => {
										const cachedBody = (caption ?? "").trim() || "<media:attachment>";
										const pendingId = rememberPendingOutboundMessageId({
											accountId: account.accountId,
											sessionKey: route.sessionKey,
											outboundTarget,
											chatGuid: chatGuidForActions ?? chatGuid,
											chatIdentifier,
											chatId,
											snippet: cachedBody
										});
										let result;
										try {
											result = await sendBlueBubblesMedia({
												cfg: config,
												to: outboundTarget,
												mediaUrl,
												caption: caption ?? void 0,
												replyToId: replyToMessageGuid || null,
												accountId: account.accountId,
												asVoice: payload.audioAsVoice === true
											});
										} catch (err) {
											forgetPendingOutboundMessageId(pendingId);
											throw err;
										}
										if (maybeEnqueueOutboundMessageId(result.messageId, cachedBody)) forgetPendingOutboundMessageId(pendingId);
										sentMessage = true;
										statusSink?.({ lastOutboundAt: Date.now() });
										if (info.kind === "block") restartTypingSoon();
									}
								});
								return;
							}
							const textLimit = account.config.textChunkLimit && account.config.textChunkLimit > 0 ? account.config.textChunkLimit : DEFAULT_TEXT_LIMIT;
							const chunkMode = account.config.chunkMode ?? "length";
							const tableMode = core.channel.text.resolveMarkdownTableMode({
								cfg: config,
								channel: "bluebubbles",
								accountId: account.accountId
							});
							const text = sanitizeReplyDirectiveText(core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode));
							const chunks = chunkMode === "newline" ? resolveTextChunksWithFallback(text, core.channel.text.chunkTextWithMode(text, textLimit, chunkMode)) : resolveTextChunksWithFallback(text, core.channel.text.chunkMarkdownText(text, textLimit));
							if (!chunks.length) return;
							for (const chunk of chunks) {
								const pendingId = rememberPendingOutboundMessageId({
									accountId: account.accountId,
									sessionKey: route.sessionKey,
									outboundTarget,
									chatGuid: chatGuidForActions ?? chatGuid,
									chatIdentifier,
									chatId,
									snippet: chunk
								});
								let result;
								try {
									result = await sendMessageBlueBubbles(outboundTarget, chunk, {
										cfg: config,
										accountId: account.accountId,
										replyToMessageGuid: replyToMessageGuid || void 0
									});
								} catch (err) {
									forgetPendingOutboundMessageId(pendingId);
									throw err;
								}
								if (maybeEnqueueOutboundMessageId(result.messageId, chunk)) forgetPendingOutboundMessageId(pendingId);
								sentMessage = true;
								statusSink?.({ lastOutboundAt: Date.now() });
								if (info.kind === "block") restartTypingSoon();
							}
						},
						onError: (err, info) => {
							if (info.kind === "final") dedupeSignal.deliveryFailed = true;
							runtime.error?.(`BlueBubbles ${info.kind} reply failed: ${sanitizeForLog(err)}`);
						}
					},
					dispatcherOptions: {
						...replyPipeline,
						onReplyStart: typingCallbacks?.onReplyStart,
						onIdle: typingCallbacks?.onIdle
					},
					replyOptions: {
						onModelSelected,
						disableBlockStreaming: typeof account.config.blockStreaming === "boolean" ? !account.config.blockStreaming : void 0
					},
					record: { onRecordError: (err) => {
						runtime.error?.(`[bluebubbles] failed updating session meta: ${sanitizeForLog(err)}`);
					} }
				})
			}
		});
	} finally {
		const shouldStopTyping = Boolean(chatGuidForActions && baseUrl && password) && (streamingActive || !sentMessage);
		streamingActive = false;
		clearTypingRestartTimer();
		if (sentMessage && chatGuidForActions && ackMessageId) core.channel.reactions.removeAckReactionAfterReply({
			removeAfterReply: removeAckAfterReply,
			ackReactionPromise,
			ackReactionValue: ackReactionValue ?? null,
			remove: () => sendBlueBubblesReaction({
				chatGuid: chatGuidForActions,
				messageGuid: ackMessageId,
				emoji: ackReactionValue ?? "",
				remove: true,
				opts: {
					cfg: config,
					accountId: account.accountId
				}
			}),
			onError: (err) => {
				logAckFailure({
					log: (msg) => logVerbose(core, runtime, msg),
					channel: "bluebubbles",
					target: `${chatGuidForActions}/${ackMessageId}`,
					error: err
				});
			}
		});
		if (shouldStopTyping && chatGuidForActions) sendBlueBubblesTyping(chatGuidForActions, false, {
			cfg: config,
			accountId: account.accountId
		}).catch((err) => {
			logTypingFailure({
				log: (msg) => logVerbose(core, runtime, msg),
				channel: "bluebubbles",
				action: "stop",
				target: chatGuidForActions,
				error: err
			});
		});
	}
}
async function processReaction(reaction, target) {
	const { account, config, runtime, core } = target;
	const pairing = createChannelPairingController({
		core,
		channel: "bluebubbles",
		accountId: account.accountId
	});
	if (reaction.fromMe) return;
	const trimmedReactionChatGuid = reaction.chatGuid?.trim();
	const trimmedReactionChatIdentifier = reaction.chatIdentifier?.trim();
	if (reaction.isGroup && !trimmedReactionChatGuid && reaction.chatId == null && !trimmedReactionChatIdentifier) {
		logVerbose(core, runtime, `dropping group reaction with no chat identifiers (senderId=${sanitizeForLog(reaction.senderId)} messageId=${sanitizeForLog(reaction.messageId)} action=${sanitizeForLog(reaction.action)})`);
		return;
	}
	const dmPolicy = account.config.dmPolicy ?? "pairing";
	const groupPolicy = account.config.groupPolicy ?? "allowlist";
	const storeAllowFrom = await readStoreAllowFromForDmPolicy({
		provider: "bluebubbles",
		accountId: account.accountId,
		dmPolicy,
		readStore: pairing.readStoreForDmPolicy
	});
	if (resolveDmGroupAccessWithLists({
		isGroup: reaction.isGroup,
		dmPolicy,
		groupPolicy,
		allowFrom: account.config.allowFrom,
		groupAllowFrom: account.config.groupAllowFrom,
		storeAllowFrom,
		isSenderAllowed: (allowFrom) => isAllowedBlueBubblesSender({
			allowFrom,
			sender: reaction.senderId,
			chatId: reaction.chatId ?? void 0,
			chatGuid: reaction.chatGuid ?? void 0,
			chatIdentifier: reaction.chatIdentifier ?? void 0
		})
	}).decision !== "allow") return;
	const chatId = reaction.chatId ?? void 0;
	const chatGuid = reaction.chatGuid ?? void 0;
	const chatIdentifier = reaction.chatIdentifier ?? void 0;
	const peerId = reaction.isGroup ? chatGuid ?? chatIdentifier ?? (chatId ? String(chatId) : "group") : reaction.senderId;
	if (reaction.isGroup && core.channel.groups.resolveRequireMention({
		cfg: config,
		channel: "bluebubbles",
		groupId: peerId,
		accountId: account.accountId
	})) {
		logVerbose(core, runtime, "bluebubbles: skipping group reaction (requireMention=true)");
		return;
	}
	const route = resolveBlueBubblesConversationRoute({
		cfg: config,
		accountId: account.accountId,
		isGroup: reaction.isGroup,
		peerId,
		sender: reaction.senderId,
		chatId,
		chatGuid,
		chatIdentifier
	});
	const senderLabel = reaction.senderName || reaction.senderId;
	const chatLabel = reaction.isGroup ? ` in group:${peerId}` : "";
	const messageDisplayId = getShortIdForUuid(reaction.messageId) || reaction.messageId;
	const text = reaction.action === "removed" ? `${senderLabel} removed ${reaction.emoji} reaction [[reply_to:${messageDisplayId}]]${chatLabel}` : `${senderLabel} reacted with ${reaction.emoji} [[reply_to:${messageDisplayId}]]${chatLabel}`;
	core.system.enqueueSystemEvent(text, {
		sessionKey: route.sessionKey,
		contextKey: `bluebubbles:reaction:${reaction.action}:${peerId}:${reaction.messageId}:${reaction.senderId}:${reaction.emoji}`
	});
	logVerbose(core, runtime, `reaction event enqueued: ${text}`);
}
//#endregion
export { warmupBlueBubblesInboundDedupe as a, sendBlueBubblesMedia as i, processMessage as n, processReaction as r, logVerbose as t };
