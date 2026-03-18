import { Q as init_home_dir, g as init_globals, m as danger, nt as __esmMin, tt as resolveRequiredHomeDir, x as shouldLogVerbose } from "./subsystem-CMvFcqxZ.js";
import { _ as pathExists$1, b as resolveUserPath, f as init_utils, n as logError, t as logDebug } from "./logger-C5Xia9ob.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import syncFs from "node:fs";
import { promisify } from "node:util";
import { execFile, spawn } from "node:child_process";
import process$1 from "node:process";
import { fileURLToPath } from "node:url";
//#region src/sessions/session-key-utils.ts
/**
* Parse agent-scoped session keys in a canonical, case-insensitive way.
* Returned values are normalized to lowercase for stable comparisons/routing.
*/
function parseAgentSessionKey(sessionKey) {
	const raw = (sessionKey ?? "").trim().toLowerCase();
	if (!raw) return null;
	const parts = raw.split(":").filter(Boolean);
	if (parts.length < 3) return null;
	if (parts[0] !== "agent") return null;
	const agentId = parts[1]?.trim();
	const rest = parts.slice(2).join(":");
	if (!agentId || !rest) return null;
	return {
		agentId,
		rest
	};
}
/**
* Best-effort chat-type extraction from session keys across canonical and legacy formats.
*/
function deriveSessionChatType(sessionKey) {
	const raw = (sessionKey ?? "").trim().toLowerCase();
	if (!raw) return "unknown";
	const scoped = parseAgentSessionKey(raw)?.rest ?? raw;
	const tokens = new Set(scoped.split(":").filter(Boolean));
	if (tokens.has("group")) return "group";
	if (tokens.has("channel")) return "channel";
	if (tokens.has("direct") || tokens.has("dm")) return "direct";
	if (/^discord:(?:[^:]+:)?guild-[^:]+:channel-[^:]+$/.test(scoped)) return "channel";
	return "unknown";
}
function isCronSessionKey(sessionKey) {
	const parsed = parseAgentSessionKey(sessionKey);
	if (!parsed) return false;
	return parsed.rest.toLowerCase().startsWith("cron:");
}
function isSubagentSessionKey(sessionKey) {
	const raw = (sessionKey ?? "").trim();
	if (!raw) return false;
	if (raw.toLowerCase().startsWith("subagent:")) return true;
	const parsed = parseAgentSessionKey(raw);
	return Boolean((parsed?.rest ?? "").toLowerCase().startsWith("subagent:"));
}
function getSubagentDepth(sessionKey) {
	const raw = (sessionKey ?? "").trim().toLowerCase();
	if (!raw) return 0;
	return raw.split(":subagent:").length - 1;
}
function isAcpSessionKey(sessionKey) {
	const raw = (sessionKey ?? "").trim();
	if (!raw) return false;
	if (raw.toLowerCase().startsWith("acp:")) return true;
	const parsed = parseAgentSessionKey(raw);
	return Boolean((parsed?.rest ?? "").toLowerCase().startsWith("acp:"));
}
function resolveThreadParentSessionKey(sessionKey) {
	const raw = (sessionKey ?? "").trim();
	if (!raw) return null;
	const normalized = raw.toLowerCase();
	let idx = -1;
	for (const marker of THREAD_SESSION_MARKERS) {
		const candidate = normalized.lastIndexOf(marker);
		if (candidate > idx) idx = candidate;
	}
	if (idx <= 0) return null;
	const parent = raw.slice(0, idx).trim();
	return parent ? parent : null;
}
var THREAD_SESSION_MARKERS;
var init_session_key_utils = __esmMin((() => {
	THREAD_SESSION_MARKERS = [":thread:", ":topic:"];
}));
//#endregion
//#region src/infra/prototype-keys.ts
function isBlockedObjectKey(key) {
	return BLOCKED_OBJECT_KEYS.has(key);
}
var BLOCKED_OBJECT_KEYS;
var init_prototype_keys = __esmMin((() => {
	BLOCKED_OBJECT_KEYS = new Set([
		"__proto__",
		"prototype",
		"constructor"
	]);
}));
//#endregion
//#region src/routing/account-id.ts
function canonicalizeAccountId(value) {
	if (VALID_ID_RE$1.test(value)) return value.toLowerCase();
	return value.toLowerCase().replace(INVALID_CHARS_RE$1, "-").replace(LEADING_DASH_RE$1, "").replace(TRAILING_DASH_RE$1, "").slice(0, 64);
}
function normalizeCanonicalAccountId(value) {
	const canonical = canonicalizeAccountId(value);
	if (!canonical || isBlockedObjectKey(canonical)) return;
	return canonical;
}
function normalizeAccountId(value) {
	const trimmed = (value ?? "").trim();
	if (!trimmed) return DEFAULT_ACCOUNT_ID;
	const cached = normalizeAccountIdCache.get(trimmed);
	if (cached) return cached;
	const normalized = normalizeCanonicalAccountId(trimmed) || "default";
	setNormalizeCache(normalizeAccountIdCache, trimmed, normalized);
	return normalized;
}
function normalizeOptionalAccountId(value) {
	const trimmed = (value ?? "").trim();
	if (!trimmed) return;
	if (normalizeOptionalAccountIdCache.has(trimmed)) return normalizeOptionalAccountIdCache.get(trimmed);
	const normalized = normalizeCanonicalAccountId(trimmed) || void 0;
	setNormalizeCache(normalizeOptionalAccountIdCache, trimmed, normalized);
	return normalized;
}
function setNormalizeCache(cache, key, value) {
	cache.set(key, value);
	if (cache.size <= ACCOUNT_ID_CACHE_MAX) return;
	const oldest = cache.keys().next();
	if (!oldest.done) cache.delete(oldest.value);
}
var DEFAULT_ACCOUNT_ID, VALID_ID_RE$1, INVALID_CHARS_RE$1, LEADING_DASH_RE$1, TRAILING_DASH_RE$1, ACCOUNT_ID_CACHE_MAX, normalizeAccountIdCache, normalizeOptionalAccountIdCache;
var init_account_id = __esmMin((() => {
	init_prototype_keys();
	DEFAULT_ACCOUNT_ID = "default";
	VALID_ID_RE$1 = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
	INVALID_CHARS_RE$1 = /[^a-z0-9_-]+/g;
	LEADING_DASH_RE$1 = /^-+/;
	TRAILING_DASH_RE$1 = /-+$/;
	ACCOUNT_ID_CACHE_MAX = 512;
	normalizeAccountIdCache = /* @__PURE__ */ new Map();
	normalizeOptionalAccountIdCache = /* @__PURE__ */ new Map();
}));
//#endregion
//#region src/routing/session-key.ts
function normalizeToken(value) {
	return (value ?? "").trim().toLowerCase();
}
function scopedHeartbeatWakeOptions(sessionKey, wakeOptions) {
	return parseAgentSessionKey(sessionKey) ? {
		...wakeOptions,
		sessionKey
	} : wakeOptions;
}
function normalizeMainKey(value) {
	const trimmed = (value ?? "").trim();
	return trimmed ? trimmed.toLowerCase() : DEFAULT_MAIN_KEY;
}
function toAgentRequestSessionKey(storeKey) {
	const raw = (storeKey ?? "").trim();
	if (!raw) return;
	return parseAgentSessionKey(raw)?.rest ?? raw;
}
function toAgentStoreSessionKey(params) {
	const raw = (params.requestKey ?? "").trim();
	if (!raw || raw.toLowerCase() === "main") return buildAgentMainSessionKey({
		agentId: params.agentId,
		mainKey: params.mainKey
	});
	const parsed = parseAgentSessionKey(raw);
	if (parsed) return `agent:${parsed.agentId}:${parsed.rest}`;
	const lowered = raw.toLowerCase();
	if (lowered.startsWith("agent:")) return lowered;
	return `agent:${normalizeAgentId(params.agentId)}:${lowered}`;
}
function resolveAgentIdFromSessionKey(sessionKey) {
	return normalizeAgentId(parseAgentSessionKey(sessionKey)?.agentId ?? "main");
}
function classifySessionKeyShape(sessionKey) {
	const raw = (sessionKey ?? "").trim();
	if (!raw) return "missing";
	if (parseAgentSessionKey(raw)) return "agent";
	return raw.toLowerCase().startsWith("agent:") ? "malformed_agent" : "legacy_or_alias";
}
function normalizeAgentId(value) {
	const trimmed = (value ?? "").trim();
	if (!trimmed) return DEFAULT_AGENT_ID;
	if (VALID_ID_RE.test(trimmed)) return trimmed.toLowerCase();
	return trimmed.toLowerCase().replace(INVALID_CHARS_RE, "-").replace(LEADING_DASH_RE, "").replace(TRAILING_DASH_RE, "").slice(0, 64) || "main";
}
function isValidAgentId(value) {
	const trimmed = (value ?? "").trim();
	return Boolean(trimmed) && VALID_ID_RE.test(trimmed);
}
function sanitizeAgentId(value) {
	return normalizeAgentId(value);
}
function buildAgentMainSessionKey(params) {
	return `agent:${normalizeAgentId(params.agentId)}:${normalizeMainKey(params.mainKey)}`;
}
function buildAgentPeerSessionKey(params) {
	const peerKind = params.peerKind ?? "direct";
	if (peerKind === "direct") {
		const dmScope = params.dmScope ?? "main";
		let peerId = (params.peerId ?? "").trim();
		const linkedPeerId = dmScope === "main" ? null : resolveLinkedPeerId({
			identityLinks: params.identityLinks,
			channel: params.channel,
			peerId
		});
		if (linkedPeerId) peerId = linkedPeerId;
		peerId = peerId.toLowerCase();
		if (dmScope === "per-account-channel-peer" && peerId) {
			const channel = (params.channel ?? "").trim().toLowerCase() || "unknown";
			const accountId = normalizeAccountId(params.accountId);
			return `agent:${normalizeAgentId(params.agentId)}:${channel}:${accountId}:direct:${peerId}`;
		}
		if (dmScope === "per-channel-peer" && peerId) {
			const channel = (params.channel ?? "").trim().toLowerCase() || "unknown";
			return `agent:${normalizeAgentId(params.agentId)}:${channel}:direct:${peerId}`;
		}
		if (dmScope === "per-peer" && peerId) return `agent:${normalizeAgentId(params.agentId)}:direct:${peerId}`;
		return buildAgentMainSessionKey({
			agentId: params.agentId,
			mainKey: params.mainKey
		});
	}
	const channel = (params.channel ?? "").trim().toLowerCase() || "unknown";
	const peerId = ((params.peerId ?? "").trim() || "unknown").toLowerCase();
	return `agent:${normalizeAgentId(params.agentId)}:${channel}:${peerKind}:${peerId}`;
}
function resolveLinkedPeerId(params) {
	const identityLinks = params.identityLinks;
	if (!identityLinks) return null;
	const peerId = params.peerId.trim();
	if (!peerId) return null;
	const candidates = /* @__PURE__ */ new Set();
	const rawCandidate = normalizeToken(peerId);
	if (rawCandidate) candidates.add(rawCandidate);
	const channel = normalizeToken(params.channel);
	if (channel) {
		const scopedCandidate = normalizeToken(`${channel}:${peerId}`);
		if (scopedCandidate) candidates.add(scopedCandidate);
	}
	if (candidates.size === 0) return null;
	for (const [canonical, ids] of Object.entries(identityLinks)) {
		const canonicalName = canonical.trim();
		if (!canonicalName) continue;
		if (!Array.isArray(ids)) continue;
		for (const id of ids) {
			const normalized = normalizeToken(id);
			if (normalized && candidates.has(normalized)) return canonicalName;
		}
	}
	return null;
}
function buildGroupHistoryKey(params) {
	const channel = normalizeToken(params.channel) || "unknown";
	const accountId = normalizeAccountId(params.accountId);
	const peerId = params.peerId.trim().toLowerCase() || "unknown";
	return `${channel}:${accountId}:${params.peerKind}:${peerId}`;
}
function resolveThreadSessionKeys(params) {
	const threadId = (params.threadId ?? "").trim();
	if (!threadId) return {
		sessionKey: params.baseSessionKey,
		parentSessionKey: void 0
	};
	const normalizedThreadId = (params.normalizeThreadId ?? ((value) => value.toLowerCase()))(threadId);
	return {
		sessionKey: params.useSuffix ?? true ? `${params.baseSessionKey}:thread:${normalizedThreadId}` : params.baseSessionKey,
		parentSessionKey: params.parentSessionKey
	};
}
var DEFAULT_AGENT_ID, DEFAULT_MAIN_KEY, VALID_ID_RE, INVALID_CHARS_RE, LEADING_DASH_RE, TRAILING_DASH_RE;
var init_session_key = __esmMin((() => {
	init_session_key_utils();
	init_account_id();
	DEFAULT_AGENT_ID = "main";
	DEFAULT_MAIN_KEY = "main";
	VALID_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
	INVALID_CHARS_RE = /[^a-z0-9_-]+/g;
	LEADING_DASH_RE = /^-+/;
	TRAILING_DASH_RE = /-+$/;
}));
//#endregion
//#region src/infra/path-guards.ts
const NOT_FOUND_CODES = new Set(["ENOENT", "ENOTDIR"]);
const SYMLINK_OPEN_CODES = new Set([
	"ELOOP",
	"EINVAL",
	"ENOTSUP"
]);
function normalizeWindowsPathForComparison(input) {
	let normalized = path.win32.normalize(input);
	if (normalized.startsWith("\\\\?\\")) {
		normalized = normalized.slice(4);
		if (normalized.toUpperCase().startsWith("UNC\\")) normalized = `\\\\${normalized.slice(4)}`;
	}
	return normalized.replaceAll("/", "\\").toLowerCase();
}
function isNodeError(value) {
	return Boolean(value && typeof value === "object" && "code" in value);
}
function hasNodeErrorCode(value, code) {
	return isNodeError(value) && value.code === code;
}
function isNotFoundPathError(value) {
	return isNodeError(value) && typeof value.code === "string" && NOT_FOUND_CODES.has(value.code);
}
function isSymlinkOpenError(value) {
	return isNodeError(value) && typeof value.code === "string" && SYMLINK_OPEN_CODES.has(value.code);
}
function isPathInside(root, target) {
	if (process.platform === "win32") {
		const rootForCompare = normalizeWindowsPathForComparison(path.win32.resolve(root));
		const targetForCompare = normalizeWindowsPathForComparison(path.win32.resolve(target));
		const relative = path.win32.relative(rootForCompare, targetForCompare);
		return relative === "" || !relative.startsWith("..") && !path.win32.isAbsolute(relative);
	}
	const resolvedRoot = path.resolve(root);
	const resolvedTarget = path.resolve(target);
	const relative = path.relative(resolvedRoot, resolvedTarget);
	return relative === "" || !relative.startsWith("..") && !path.isAbsolute(relative);
}
//#endregion
//#region src/infra/boundary-path.ts
const BOUNDARY_PATH_ALIAS_POLICIES = {
	strict: Object.freeze({
		allowFinalSymlinkForUnlink: false,
		allowFinalHardlinkForUnlink: false
	}),
	unlinkTarget: Object.freeze({
		allowFinalSymlinkForUnlink: true,
		allowFinalHardlinkForUnlink: true
	})
};
async function resolveBoundaryPath(params) {
	const rootPath = path.resolve(params.rootPath);
	const absolutePath = path.resolve(params.absolutePath);
	const context = createBoundaryResolutionContext({
		resolveParams: params,
		rootPath,
		absolutePath,
		rootCanonicalPath: params.rootCanonicalPath ? path.resolve(params.rootCanonicalPath) : await resolvePathViaExistingAncestor(rootPath),
		outsideLexicalCanonicalPath: await resolveOutsideLexicalCanonicalPathAsync({
			rootPath,
			absolutePath
		})
	});
	const outsideResult = await resolveOutsideBoundaryPathAsync({
		boundaryLabel: params.boundaryLabel,
		context
	});
	if (outsideResult) return outsideResult;
	return resolveBoundaryPathLexicalAsync({
		params,
		absolutePath: context.absolutePath,
		rootPath: context.rootPath,
		rootCanonicalPath: context.rootCanonicalPath
	});
}
function resolveBoundaryPathSync(params) {
	const rootPath = path.resolve(params.rootPath);
	const absolutePath = path.resolve(params.absolutePath);
	const context = createBoundaryResolutionContext({
		resolveParams: params,
		rootPath,
		absolutePath,
		rootCanonicalPath: params.rootCanonicalPath ? path.resolve(params.rootCanonicalPath) : resolvePathViaExistingAncestorSync(rootPath),
		outsideLexicalCanonicalPath: resolveOutsideLexicalCanonicalPathSync({
			rootPath,
			absolutePath
		})
	});
	const outsideResult = resolveOutsideBoundaryPathSync({
		boundaryLabel: params.boundaryLabel,
		context
	});
	if (outsideResult) return outsideResult;
	return resolveBoundaryPathLexicalSync({
		params,
		absolutePath: context.absolutePath,
		rootPath: context.rootPath,
		rootCanonicalPath: context.rootCanonicalPath
	});
}
function isPromiseLike(value) {
	return Boolean(value && (typeof value === "object" || typeof value === "function") && "then" in value && typeof value.then === "function");
}
function createLexicalTraversalState(params) {
	return {
		segments: path.relative(params.rootPath, params.absolutePath).split(path.sep).filter(Boolean),
		allowFinalSymlink: params.params.policy?.allowFinalSymlinkForUnlink === true,
		canonicalCursor: params.rootCanonicalPath,
		lexicalCursor: params.rootPath,
		preserveFinalSymlink: false
	};
}
function assertLexicalCursorInsideBoundary(params) {
	assertInsideBoundary({
		boundaryLabel: params.params.boundaryLabel,
		rootCanonicalPath: params.rootCanonicalPath,
		candidatePath: params.candidatePath,
		absolutePath: params.absolutePath
	});
}
function applyMissingSuffixToCanonicalCursor(params) {
	const missingSuffix = params.state.segments.slice(params.missingFromIndex);
	params.state.canonicalCursor = path.resolve(params.state.canonicalCursor, ...missingSuffix);
	assertLexicalCursorInsideBoundary({
		params: params.params,
		rootCanonicalPath: params.rootCanonicalPath,
		candidatePath: params.state.canonicalCursor,
		absolutePath: params.absolutePath
	});
}
function advanceCanonicalCursorForSegment(params) {
	params.state.canonicalCursor = path.resolve(params.state.canonicalCursor, params.segment);
	assertLexicalCursorInsideBoundary({
		params: params.params,
		rootCanonicalPath: params.rootCanonicalPath,
		candidatePath: params.state.canonicalCursor,
		absolutePath: params.absolutePath
	});
}
function finalizeLexicalResolution(params) {
	assertLexicalCursorInsideBoundary({
		params: params.params,
		rootCanonicalPath: params.rootCanonicalPath,
		candidatePath: params.state.canonicalCursor,
		absolutePath: params.absolutePath
	});
	return buildResolvedBoundaryPath({
		absolutePath: params.absolutePath,
		canonicalPath: params.state.canonicalCursor,
		rootPath: params.rootPath,
		rootCanonicalPath: params.rootCanonicalPath,
		kind: params.kind
	});
}
function handleLexicalLstatFailure(params) {
	if (!isNotFoundPathError(params.error)) return false;
	applyMissingSuffixToCanonicalCursor({
		state: params.state,
		missingFromIndex: params.missingFromIndex,
		rootCanonicalPath: params.rootCanonicalPath,
		params: params.resolveParams,
		absolutePath: params.absolutePath
	});
	return true;
}
function handleLexicalStatReadFailure(params) {
	if (handleLexicalLstatFailure({
		error: params.error,
		state: params.state,
		missingFromIndex: params.missingFromIndex,
		rootCanonicalPath: params.rootCanonicalPath,
		resolveParams: params.resolveParams,
		absolutePath: params.absolutePath
	})) return null;
	throw params.error;
}
function handleLexicalStatDisposition(params) {
	if (!params.isSymbolicLink) {
		advanceCanonicalCursorForSegment({
			state: params.state,
			segment: params.segment,
			rootCanonicalPath: params.rootCanonicalPath,
			params: params.resolveParams,
			absolutePath: params.absolutePath
		});
		return "continue";
	}
	if (params.state.allowFinalSymlink && params.isLast) {
		params.state.preserveFinalSymlink = true;
		advanceCanonicalCursorForSegment({
			state: params.state,
			segment: params.segment,
			rootCanonicalPath: params.rootCanonicalPath,
			params: params.resolveParams,
			absolutePath: params.absolutePath
		});
		return "break";
	}
	return "resolve-link";
}
function applyResolvedSymlinkHop(params) {
	if (!isPathInside(params.rootCanonicalPath, params.linkCanonical)) throw symlinkEscapeError({
		boundaryLabel: params.boundaryLabel,
		rootCanonicalPath: params.rootCanonicalPath,
		symlinkPath: params.state.lexicalCursor
	});
	params.state.canonicalCursor = params.linkCanonical;
	params.state.lexicalCursor = params.linkCanonical;
}
function readLexicalStat(params) {
	try {
		const stat = params.read(params.state.lexicalCursor);
		if (isPromiseLike(stat)) return Promise.resolve(stat).catch((error) => handleLexicalStatReadFailure({
			...params,
			error
		}));
		return stat;
	} catch (error) {
		return handleLexicalStatReadFailure({
			...params,
			error
		});
	}
}
function resolveAndApplySymlinkHop(params) {
	const linkCanonical = params.resolveLinkCanonical(params.state.lexicalCursor);
	if (isPromiseLike(linkCanonical)) return Promise.resolve(linkCanonical).then((value) => applyResolvedSymlinkHop({
		state: params.state,
		linkCanonical: value,
		rootCanonicalPath: params.rootCanonicalPath,
		boundaryLabel: params.boundaryLabel
	}));
	applyResolvedSymlinkHop({
		state: params.state,
		linkCanonical,
		rootCanonicalPath: params.rootCanonicalPath,
		boundaryLabel: params.boundaryLabel
	});
}
function* iterateLexicalTraversal(state) {
	for (let idx = 0; idx < state.segments.length; idx += 1) {
		const segment = state.segments[idx] ?? "";
		const isLast = idx === state.segments.length - 1;
		state.lexicalCursor = path.join(state.lexicalCursor, segment);
		yield {
			idx,
			segment,
			isLast
		};
	}
}
async function resolveBoundaryPathLexicalAsync(params) {
	const state = createLexicalTraversalState(params);
	const sharedStepParams = {
		state,
		rootCanonicalPath: params.rootCanonicalPath,
		resolveParams: params.params,
		absolutePath: params.absolutePath
	};
	for (const { idx, segment, isLast } of iterateLexicalTraversal(state)) {
		const stat = await readLexicalStat({
			...sharedStepParams,
			missingFromIndex: idx,
			read: (cursor) => fs.lstat(cursor)
		});
		if (!stat) break;
		const disposition = handleLexicalStatDisposition({
			...sharedStepParams,
			isSymbolicLink: stat.isSymbolicLink(),
			segment,
			isLast
		});
		if (disposition === "continue") continue;
		if (disposition === "break") break;
		await resolveAndApplySymlinkHop({
			state,
			rootCanonicalPath: params.rootCanonicalPath,
			boundaryLabel: params.params.boundaryLabel,
			resolveLinkCanonical: (cursor) => resolveSymlinkHopPath(cursor)
		});
	}
	const kind = await getPathKind(params.absolutePath, state.preserveFinalSymlink);
	return finalizeLexicalResolution({
		...params,
		state,
		kind
	});
}
function resolveBoundaryPathLexicalSync(params) {
	const state = createLexicalTraversalState(params);
	for (let idx = 0; idx < state.segments.length; idx += 1) {
		const segment = state.segments[idx] ?? "";
		const isLast = idx === state.segments.length - 1;
		state.lexicalCursor = path.join(state.lexicalCursor, segment);
		const maybeStat = readLexicalStat({
			state,
			missingFromIndex: idx,
			rootCanonicalPath: params.rootCanonicalPath,
			resolveParams: params.params,
			absolutePath: params.absolutePath,
			read: (cursor) => syncFs.lstatSync(cursor)
		});
		if (isPromiseLike(maybeStat)) throw new Error("Unexpected async lexical stat");
		const stat = maybeStat;
		if (!stat) break;
		const disposition = handleLexicalStatDisposition({
			state,
			isSymbolicLink: stat.isSymbolicLink(),
			segment,
			isLast,
			rootCanonicalPath: params.rootCanonicalPath,
			resolveParams: params.params,
			absolutePath: params.absolutePath
		});
		if (disposition === "continue") continue;
		if (disposition === "break") break;
		if (isPromiseLike(resolveAndApplySymlinkHop({
			state,
			rootCanonicalPath: params.rootCanonicalPath,
			boundaryLabel: params.params.boundaryLabel,
			resolveLinkCanonical: (cursor) => resolveSymlinkHopPathSync(cursor)
		}))) throw new Error("Unexpected async symlink resolution");
	}
	const kind = getPathKindSync(params.absolutePath, state.preserveFinalSymlink);
	return finalizeLexicalResolution({
		...params,
		state,
		kind
	});
}
function resolveCanonicalOutsideLexicalPath(params) {
	return params.outsideLexicalCanonicalPath ?? params.absolutePath;
}
function createBoundaryResolutionContext(params) {
	const lexicalInside = isPathInside(params.rootPath, params.absolutePath);
	const canonicalOutsideLexicalPath = resolveCanonicalOutsideLexicalPath({
		absolutePath: params.absolutePath,
		outsideLexicalCanonicalPath: params.outsideLexicalCanonicalPath
	});
	assertLexicalBoundaryOrCanonicalAlias({
		skipLexicalRootCheck: params.resolveParams.skipLexicalRootCheck,
		lexicalInside,
		canonicalOutsideLexicalPath,
		rootCanonicalPath: params.rootCanonicalPath,
		boundaryLabel: params.resolveParams.boundaryLabel,
		rootPath: params.rootPath,
		absolutePath: params.absolutePath
	});
	return {
		rootPath: params.rootPath,
		absolutePath: params.absolutePath,
		rootCanonicalPath: params.rootCanonicalPath,
		lexicalInside,
		canonicalOutsideLexicalPath
	};
}
async function resolveOutsideBoundaryPathAsync(params) {
	if (params.context.lexicalInside) return null;
	const kind = await getPathKind(params.context.absolutePath, false);
	return buildOutsideBoundaryPathFromContext({
		boundaryLabel: params.boundaryLabel,
		context: params.context,
		kind
	});
}
function resolveOutsideBoundaryPathSync(params) {
	if (params.context.lexicalInside) return null;
	const kind = getPathKindSync(params.context.absolutePath, false);
	return buildOutsideBoundaryPathFromContext({
		boundaryLabel: params.boundaryLabel,
		context: params.context,
		kind
	});
}
function buildOutsideBoundaryPathFromContext(params) {
	return buildOutsideLexicalBoundaryPath({
		boundaryLabel: params.boundaryLabel,
		rootCanonicalPath: params.context.rootCanonicalPath,
		absolutePath: params.context.absolutePath,
		canonicalOutsideLexicalPath: params.context.canonicalOutsideLexicalPath,
		rootPath: params.context.rootPath,
		kind: params.kind
	});
}
async function resolveOutsideLexicalCanonicalPathAsync(params) {
	if (isPathInside(params.rootPath, params.absolutePath)) return;
	return await resolvePathViaExistingAncestor(params.absolutePath);
}
function resolveOutsideLexicalCanonicalPathSync(params) {
	if (isPathInside(params.rootPath, params.absolutePath)) return;
	return resolvePathViaExistingAncestorSync(params.absolutePath);
}
function buildOutsideLexicalBoundaryPath(params) {
	assertInsideBoundary({
		boundaryLabel: params.boundaryLabel,
		rootCanonicalPath: params.rootCanonicalPath,
		candidatePath: params.canonicalOutsideLexicalPath,
		absolutePath: params.absolutePath
	});
	return buildResolvedBoundaryPath({
		absolutePath: params.absolutePath,
		canonicalPath: params.canonicalOutsideLexicalPath,
		rootPath: params.rootPath,
		rootCanonicalPath: params.rootCanonicalPath,
		kind: params.kind
	});
}
function assertLexicalBoundaryOrCanonicalAlias(params) {
	if (params.skipLexicalRootCheck || params.lexicalInside) return;
	if (isPathInside(params.rootCanonicalPath, params.canonicalOutsideLexicalPath)) return;
	throw pathEscapeError({
		boundaryLabel: params.boundaryLabel,
		rootPath: params.rootPath,
		absolutePath: params.absolutePath
	});
}
function buildResolvedBoundaryPath(params) {
	return {
		absolutePath: params.absolutePath,
		canonicalPath: params.canonicalPath,
		rootPath: params.rootPath,
		rootCanonicalPath: params.rootCanonicalPath,
		relativePath: relativeInsideRoot(params.rootCanonicalPath, params.canonicalPath),
		exists: params.kind.exists,
		kind: params.kind.kind
	};
}
async function resolvePathViaExistingAncestor(targetPath) {
	const normalized = path.resolve(targetPath);
	let cursor = normalized;
	const missingSuffix = [];
	while (!isFilesystemRoot(cursor) && !await pathExists(cursor)) {
		missingSuffix.unshift(path.basename(cursor));
		const parent = path.dirname(cursor);
		if (parent === cursor) break;
		cursor = parent;
	}
	if (!await pathExists(cursor)) return normalized;
	try {
		const resolvedAncestor = path.resolve(await fs.realpath(cursor));
		if (missingSuffix.length === 0) return resolvedAncestor;
		return path.resolve(resolvedAncestor, ...missingSuffix);
	} catch {
		return normalized;
	}
}
function resolvePathViaExistingAncestorSync(targetPath) {
	const normalized = path.resolve(targetPath);
	let cursor = normalized;
	const missingSuffix = [];
	while (!isFilesystemRoot(cursor) && !syncFs.existsSync(cursor)) {
		missingSuffix.unshift(path.basename(cursor));
		const parent = path.dirname(cursor);
		if (parent === cursor) break;
		cursor = parent;
	}
	if (!syncFs.existsSync(cursor)) return normalized;
	try {
		const resolvedAncestor = path.resolve(syncFs.realpathSync(cursor));
		if (missingSuffix.length === 0) return resolvedAncestor;
		return path.resolve(resolvedAncestor, ...missingSuffix);
	} catch {
		return normalized;
	}
}
async function getPathKind(absolutePath, preserveFinalSymlink) {
	try {
		return {
			exists: true,
			kind: toResolvedKind(preserveFinalSymlink ? await fs.lstat(absolutePath) : await fs.stat(absolutePath))
		};
	} catch (error) {
		if (isNotFoundPathError(error)) return {
			exists: false,
			kind: "missing"
		};
		throw error;
	}
}
function getPathKindSync(absolutePath, preserveFinalSymlink) {
	try {
		return {
			exists: true,
			kind: toResolvedKind(preserveFinalSymlink ? syncFs.lstatSync(absolutePath) : syncFs.statSync(absolutePath))
		};
	} catch (error) {
		if (isNotFoundPathError(error)) return {
			exists: false,
			kind: "missing"
		};
		throw error;
	}
}
function toResolvedKind(stat) {
	if (stat.isFile()) return "file";
	if (stat.isDirectory()) return "directory";
	if (stat.isSymbolicLink()) return "symlink";
	return "other";
}
function relativeInsideRoot(rootPath, targetPath) {
	const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
	if (!relative || relative === ".") return "";
	if (relative.startsWith("..") || path.isAbsolute(relative)) return "";
	return relative;
}
function assertInsideBoundary(params) {
	if (isPathInside(params.rootCanonicalPath, params.candidatePath)) return;
	throw new Error(`Path resolves outside ${params.boundaryLabel} (${shortPath(params.rootCanonicalPath)}): ${shortPath(params.absolutePath)}`);
}
function pathEscapeError(params) {
	return /* @__PURE__ */ new Error(`Path escapes ${params.boundaryLabel} (${shortPath(params.rootPath)}): ${shortPath(params.absolutePath)}`);
}
function symlinkEscapeError(params) {
	return /* @__PURE__ */ new Error(`Symlink escapes ${params.boundaryLabel} (${shortPath(params.rootCanonicalPath)}): ${shortPath(params.symlinkPath)}`);
}
function shortPath(value) {
	const home = os.homedir();
	if (value.startsWith(home)) return `~${value.slice(home.length)}`;
	return value;
}
function isFilesystemRoot(candidate) {
	return path.parse(candidate).root === candidate;
}
async function pathExists(targetPath) {
	try {
		await fs.lstat(targetPath);
		return true;
	} catch (error) {
		if (isNotFoundPathError(error)) return false;
		throw error;
	}
}
async function resolveSymlinkHopPath(symlinkPath) {
	try {
		return path.resolve(await fs.realpath(symlinkPath));
	} catch (error) {
		if (!isNotFoundPathError(error)) throw error;
		const linkTarget = await fs.readlink(symlinkPath);
		return resolvePathViaExistingAncestor(path.resolve(path.dirname(symlinkPath), linkTarget));
	}
}
function resolveSymlinkHopPathSync(symlinkPath) {
	try {
		return path.resolve(syncFs.realpathSync(symlinkPath));
	} catch (error) {
		if (!isNotFoundPathError(error)) throw error;
		const linkTarget = syncFs.readlinkSync(symlinkPath);
		return resolvePathViaExistingAncestorSync(path.resolve(path.dirname(symlinkPath), linkTarget));
	}
}
//#endregion
//#region src/infra/file-identity.ts
function isZero(value) {
	return value === 0 || value === 0n;
}
function sameFileIdentity$1(left, right, platform = process.platform) {
	if (left.ino !== right.ino) return false;
	if (left.dev === right.dev) return true;
	return platform === "win32" && (isZero(left.dev) || isZero(right.dev));
}
//#endregion
//#region src/infra/safe-open-sync.ts
function isExpectedPathError(error) {
	const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
	return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}
function sameFileIdentity(left, right) {
	return sameFileIdentity$1(left, right);
}
function openVerifiedFileSync(params) {
	const ioFs = params.ioFs ?? syncFs;
	const allowedType = params.allowedType ?? "file";
	const openReadFlags = ioFs.constants.O_RDONLY | (typeof ioFs.constants.O_NOFOLLOW === "number" ? ioFs.constants.O_NOFOLLOW : 0);
	let fd = null;
	try {
		if (params.rejectPathSymlink) {
			if (ioFs.lstatSync(params.filePath).isSymbolicLink()) return {
				ok: false,
				reason: "validation"
			};
		}
		const realPath = params.resolvedPath ?? ioFs.realpathSync(params.filePath);
		const preOpenStat = ioFs.lstatSync(realPath);
		if (!isAllowedType(preOpenStat, allowedType)) return {
			ok: false,
			reason: "validation"
		};
		if (params.rejectHardlinks && preOpenStat.isFile() && preOpenStat.nlink > 1) return {
			ok: false,
			reason: "validation"
		};
		if (params.maxBytes !== void 0 && preOpenStat.isFile() && preOpenStat.size > params.maxBytes) return {
			ok: false,
			reason: "validation"
		};
		fd = ioFs.openSync(realPath, openReadFlags);
		const openedStat = ioFs.fstatSync(fd);
		if (!isAllowedType(openedStat, allowedType)) return {
			ok: false,
			reason: "validation"
		};
		if (params.rejectHardlinks && openedStat.isFile() && openedStat.nlink > 1) return {
			ok: false,
			reason: "validation"
		};
		if (params.maxBytes !== void 0 && openedStat.isFile() && openedStat.size > params.maxBytes) return {
			ok: false,
			reason: "validation"
		};
		if (!sameFileIdentity(preOpenStat, openedStat)) return {
			ok: false,
			reason: "validation"
		};
		const opened = {
			ok: true,
			path: realPath,
			fd,
			stat: openedStat
		};
		fd = null;
		return opened;
	} catch (error) {
		if (isExpectedPathError(error)) return {
			ok: false,
			reason: "path",
			error
		};
		return {
			ok: false,
			reason: "io",
			error
		};
	} finally {
		if (fd !== null) ioFs.closeSync(fd);
	}
}
function isAllowedType(stat, allowedType) {
	if (allowedType === "directory") return stat.isDirectory();
	return stat.isFile();
}
//#endregion
//#region src/infra/boundary-file-read.ts
function canUseBoundaryFileOpen(ioFs) {
	return typeof ioFs.openSync === "function" && typeof ioFs.closeSync === "function" && typeof ioFs.fstatSync === "function" && typeof ioFs.lstatSync === "function" && typeof ioFs.realpathSync === "function" && typeof ioFs.readFileSync === "function" && typeof ioFs.constants === "object" && ioFs.constants !== null;
}
function openBoundaryFileSync(params) {
	const ioFs = params.ioFs ?? syncFs;
	const resolved = resolveBoundaryFilePathGeneric({
		absolutePath: params.absolutePath,
		resolve: (absolutePath) => resolveBoundaryPathSync({
			absolutePath,
			rootPath: params.rootPath,
			rootCanonicalPath: params.rootRealPath,
			boundaryLabel: params.boundaryLabel,
			skipLexicalRootCheck: params.skipLexicalRootCheck
		})
	});
	if (resolved instanceof Promise) return toBoundaryValidationError(/* @__PURE__ */ new Error("Unexpected async boundary resolution"));
	return finalizeBoundaryFileOpen({
		resolved,
		maxBytes: params.maxBytes,
		rejectHardlinks: params.rejectHardlinks,
		allowedType: params.allowedType,
		ioFs
	});
}
function openBoundaryFileResolved(params) {
	const opened = openVerifiedFileSync({
		filePath: params.absolutePath,
		resolvedPath: params.resolvedPath,
		rejectHardlinks: params.rejectHardlinks ?? true,
		maxBytes: params.maxBytes,
		allowedType: params.allowedType,
		ioFs: params.ioFs
	});
	if (!opened.ok) return opened;
	return {
		ok: true,
		path: opened.path,
		fd: opened.fd,
		stat: opened.stat,
		rootRealPath: params.rootRealPath
	};
}
function finalizeBoundaryFileOpen(params) {
	if ("ok" in params.resolved) return params.resolved;
	return openBoundaryFileResolved({
		absolutePath: params.resolved.absolutePath,
		resolvedPath: params.resolved.resolvedPath,
		rootRealPath: params.resolved.rootRealPath,
		maxBytes: params.maxBytes,
		rejectHardlinks: params.rejectHardlinks,
		allowedType: params.allowedType,
		ioFs: params.ioFs
	});
}
async function openBoundaryFile(params) {
	const ioFs = params.ioFs ?? syncFs;
	const maybeResolved = resolveBoundaryFilePathGeneric({
		absolutePath: params.absolutePath,
		resolve: (absolutePath) => resolveBoundaryPath({
			absolutePath,
			rootPath: params.rootPath,
			rootCanonicalPath: params.rootRealPath,
			boundaryLabel: params.boundaryLabel,
			policy: params.aliasPolicy,
			skipLexicalRootCheck: params.skipLexicalRootCheck
		})
	});
	return finalizeBoundaryFileOpen({
		resolved: maybeResolved instanceof Promise ? await maybeResolved : maybeResolved,
		maxBytes: params.maxBytes,
		rejectHardlinks: params.rejectHardlinks,
		allowedType: params.allowedType,
		ioFs
	});
}
function toBoundaryValidationError(error) {
	return {
		ok: false,
		reason: "validation",
		error
	};
}
function mapResolvedBoundaryPath(absolutePath, resolved) {
	return {
		absolutePath,
		resolvedPath: resolved.canonicalPath,
		rootRealPath: resolved.rootCanonicalPath
	};
}
function resolveBoundaryFilePathGeneric(params) {
	const absolutePath = path.resolve(params.absolutePath);
	try {
		const resolved = params.resolve(absolutePath);
		if (resolved instanceof Promise) return resolved.then((value) => mapResolvedBoundaryPath(absolutePath, value)).catch((error) => toBoundaryValidationError(error));
		return mapResolvedBoundaryPath(absolutePath, resolved);
	} catch (error) {
		return toBoundaryValidationError(error);
	}
}
//#endregion
//#region src/infra/openclaw-exec-env.ts
const OPENCLAW_CLI_ENV_VAR = "OPENCLAW_CLI";
function markOpenClawExecEnv(env) {
	return {
		...env,
		[OPENCLAW_CLI_ENV_VAR]: "1"
	};
}
//#endregion
//#region src/process/spawn-utils.ts
const DEFAULT_RETRY_CODES = ["EBADF"];
function resolveCommandStdio(params) {
	return [
		params.hasInput ? "pipe" : params.preferInherit ? "inherit" : "pipe",
		"pipe",
		"pipe"
	];
}
function shouldRetry(err, codes) {
	const code = err && typeof err === "object" && "code" in err ? String(err.code) : "";
	return code.length > 0 && codes.includes(code);
}
async function spawnAndWaitForSpawn(spawnImpl, argv, options) {
	const child = spawnImpl(argv[0], argv.slice(1), options);
	return await new Promise((resolve, reject) => {
		let settled = false;
		const cleanup = () => {
			child.removeListener("error", onError);
			child.removeListener("spawn", onSpawn);
		};
		const finishResolve = () => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(child);
		};
		const onError = (err) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(err);
		};
		const onSpawn = () => {
			finishResolve();
		};
		child.once("error", onError);
		child.once("spawn", onSpawn);
		process.nextTick(() => {
			if (typeof child.pid === "number") finishResolve();
		});
	});
}
async function spawnWithFallback(params) {
	const spawnImpl = params.spawnImpl ?? spawn;
	const retryCodes = params.retryCodes ?? DEFAULT_RETRY_CODES;
	const baseOptions = { ...params.options };
	const fallbacks = params.fallbacks ?? [];
	const attempts = [{ options: baseOptions }, ...fallbacks.map((fallback) => ({
		label: fallback.label,
		options: {
			...baseOptions,
			...fallback.options
		}
	}))];
	let lastError;
	for (let index = 0; index < attempts.length; index += 1) {
		const attempt = attempts[index];
		try {
			return {
				child: await spawnAndWaitForSpawn(spawnImpl, params.argv, attempt.options),
				usedFallback: index > 0,
				fallbackLabel: attempt.label
			};
		} catch (err) {
			lastError = err;
			const nextFallback = fallbacks[index];
			if (!nextFallback || !shouldRetry(err, retryCodes)) throw err;
			params.onFallback?.(err, nextFallback);
		}
	}
	throw lastError;
}
//#endregion
//#region src/process/windows-command.ts
function resolveWindowsCommandShim(params) {
	if ((params.platform ?? process$1.platform) !== "win32") return params.command;
	const basename = path.basename(params.command).toLowerCase();
	if (path.extname(basename)) return params.command;
	if (params.cmdCommands.includes(basename)) return `${params.command}.cmd`;
	return params.command;
}
//#endregion
//#region src/process/exec.ts
init_globals();
const execFileAsync = promisify(execFile);
const WINDOWS_UNSAFE_CMD_CHARS_RE = /[&|<>^%\r\n]/;
function isWindowsBatchCommand(resolvedCommand) {
	if (process$1.platform !== "win32") return false;
	const ext = path.extname(resolvedCommand).toLowerCase();
	return ext === ".cmd" || ext === ".bat";
}
function escapeForCmdExe(arg) {
	if (WINDOWS_UNSAFE_CMD_CHARS_RE.test(arg)) throw new Error(`Unsafe Windows cmd.exe argument detected: ${JSON.stringify(arg)}. Pass an explicit shell-wrapper argv at the call site instead.`);
	if (!arg.includes(" ") && !arg.includes("\"")) return arg;
	return `"${arg.replace(/"/g, "\"\"")}"`;
}
function buildCmdExeCommandLine(resolvedCommand, args) {
	return [escapeForCmdExe(resolvedCommand), ...args.map(escapeForCmdExe)].join(" ");
}
/**
* On Windows, Node 18.20.2+ (CVE-2024-27980) rejects spawning .cmd/.bat directly
* without shell, causing EINVAL. Resolve npm/npx to node + cli script so we
* spawn node.exe instead of npm.cmd.
*/
function resolveNpmArgvForWindows(argv) {
	if (process$1.platform !== "win32" || argv.length === 0) return null;
	const basename = path.basename(argv[0]).toLowerCase().replace(/\.(cmd|exe|bat)$/, "");
	const cliName = basename === "npx" ? "npx-cli.js" : basename === "npm" ? "npm-cli.js" : null;
	if (!cliName) return null;
	const nodeDir = path.dirname(process$1.execPath);
	const cliPath = path.join(nodeDir, "node_modules", "npm", "bin", cliName);
	if (!syncFs.existsSync(cliPath)) {
		const command = argv[0] ?? "";
		return [path.extname(command).toLowerCase() ? command : `${command}.cmd`, ...argv.slice(1)];
	}
	return [
		process$1.execPath,
		cliPath,
		...argv.slice(1)
	];
}
/**
* Resolves a command for Windows compatibility.
* On Windows, non-.exe commands (like pnpm, yarn) are resolved to .cmd; npm/npx
* are handled by resolveNpmArgvForWindows to avoid spawn EINVAL (no direct .cmd).
*/
function resolveCommand(command) {
	return resolveWindowsCommandShim({
		command,
		cmdCommands: ["pnpm", "yarn"]
	});
}
function shouldSpawnWithShell(params) {
	return false;
}
async function runExec(command, args, opts = 1e4) {
	const options = typeof opts === "number" ? {
		timeout: opts,
		encoding: "utf8"
	} : {
		timeout: opts.timeoutMs,
		maxBuffer: opts.maxBuffer,
		cwd: opts.cwd,
		encoding: "utf8"
	};
	try {
		const argv = [command, ...args];
		let execCommand;
		let execArgs;
		if (process$1.platform === "win32") {
			const resolved = resolveNpmArgvForWindows(argv);
			if (resolved) {
				execCommand = resolved[0] ?? "";
				execArgs = resolved.slice(1);
			} else {
				execCommand = resolveCommand(command);
				execArgs = args;
			}
		} else {
			execCommand = resolveCommand(command);
			execArgs = args;
		}
		const { stdout, stderr } = isWindowsBatchCommand(execCommand) ? await execFileAsync(process$1.env.ComSpec ?? "cmd.exe", [
			"/d",
			"/s",
			"/c",
			buildCmdExeCommandLine(execCommand, execArgs)
		], {
			...options,
			windowsVerbatimArguments: true
		}) : await execFileAsync(execCommand, execArgs, options);
		if (shouldLogVerbose()) {
			if (stdout.trim()) logDebug(stdout.trim());
			if (stderr.trim()) logError(stderr.trim());
		}
		return {
			stdout,
			stderr
		};
	} catch (err) {
		if (shouldLogVerbose()) logError(danger(`Command failed: ${command} ${args.join(" ")}`));
		throw err;
	}
}
function resolveCommandEnv(params) {
	const baseEnv = params.baseEnv ?? process$1.env;
	const argv = params.argv;
	const shouldSuppressNpmFund = (() => {
		const cmd = path.basename(argv[0] ?? "");
		if (cmd === "npm" || cmd === "npm.cmd" || cmd === "npm.exe") return true;
		if (cmd === "node" || cmd === "node.exe") return (argv[1] ?? "").includes("npm-cli.js");
		return false;
	})();
	const mergedEnv = params.env ? {
		...baseEnv,
		...params.env
	} : { ...baseEnv };
	const resolvedEnv = Object.fromEntries(Object.entries(mergedEnv).filter(([, value]) => value !== void 0).map(([key, value]) => [key, String(value)]));
	if (shouldSuppressNpmFund) {
		if (resolvedEnv.NPM_CONFIG_FUND == null) resolvedEnv.NPM_CONFIG_FUND = "false";
		if (resolvedEnv.npm_config_fund == null) resolvedEnv.npm_config_fund = "false";
	}
	return markOpenClawExecEnv(resolvedEnv);
}
async function runCommandWithTimeout(argv, optionsOrTimeout) {
	const options = typeof optionsOrTimeout === "number" ? { timeoutMs: optionsOrTimeout } : optionsOrTimeout;
	const { timeoutMs, cwd, input, env, noOutputTimeoutMs } = options;
	const { windowsVerbatimArguments } = options;
	const hasInput = input !== void 0;
	const resolvedEnv = resolveCommandEnv({
		argv,
		env
	});
	const stdio = resolveCommandStdio({
		hasInput,
		preferInherit: true
	});
	const finalArgv = process$1.platform === "win32" ? resolveNpmArgvForWindows(argv) ?? argv : argv;
	const resolvedCommand = finalArgv !== argv ? finalArgv[0] ?? "" : resolveCommand(argv[0] ?? "");
	const useCmdWrapper = isWindowsBatchCommand(resolvedCommand);
	const child = spawn(useCmdWrapper ? process$1.env.ComSpec ?? "cmd.exe" : resolvedCommand, useCmdWrapper ? [
		"/d",
		"/s",
		"/c",
		buildCmdExeCommandLine(resolvedCommand, finalArgv.slice(1))
	] : finalArgv.slice(1), {
		stdio,
		cwd,
		env: resolvedEnv,
		windowsVerbatimArguments: useCmdWrapper ? true : windowsVerbatimArguments,
		...shouldSpawnWithShell({
			resolvedCommand,
			platform: process$1.platform
		}) ? { shell: true } : {}
	});
	return await new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timedOut = false;
		let noOutputTimedOut = false;
		let noOutputTimer = null;
		const shouldTrackOutputTimeout = typeof noOutputTimeoutMs === "number" && Number.isFinite(noOutputTimeoutMs) && noOutputTimeoutMs > 0;
		const clearNoOutputTimer = () => {
			if (!noOutputTimer) return;
			clearTimeout(noOutputTimer);
			noOutputTimer = null;
		};
		const armNoOutputTimer = () => {
			if (!shouldTrackOutputTimeout || settled) return;
			clearNoOutputTimer();
			noOutputTimer = setTimeout(() => {
				if (settled) return;
				noOutputTimedOut = true;
				if (typeof child.kill === "function") child.kill("SIGKILL");
			}, Math.floor(noOutputTimeoutMs));
		};
		const timer = setTimeout(() => {
			timedOut = true;
			if (typeof child.kill === "function") child.kill("SIGKILL");
		}, timeoutMs);
		armNoOutputTimer();
		if (hasInput && child.stdin) {
			child.stdin.write(input ?? "");
			child.stdin.end();
		}
		child.stdout?.on("data", (d) => {
			stdout += d.toString();
			armNoOutputTimer();
		});
		child.stderr?.on("data", (d) => {
			stderr += d.toString();
			armNoOutputTimer();
		});
		child.on("error", (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearNoOutputTimer();
			reject(err);
		});
		child.on("close", (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearNoOutputTimer();
			const termination = noOutputTimedOut ? "no-output-timeout" : timedOut ? "timeout" : signal != null ? "signal" : "exit";
			resolve({
				pid: child.pid ?? void 0,
				stdout,
				stderr,
				code,
				signal,
				killed: child.killed,
				termination,
				noOutputTimedOut
			});
		});
	});
}
//#endregion
//#region src/infra/openclaw-root.ts
const CORE_PACKAGE_NAMES = new Set(["openclaw"]);
function parsePackageName(raw) {
	const parsed = JSON.parse(raw);
	return typeof parsed.name === "string" ? parsed.name : null;
}
async function readPackageName(dir) {
	try {
		return parsePackageName(await fs.readFile(path.join(dir, "package.json"), "utf-8"));
	} catch {
		return null;
	}
}
function readPackageNameSync(dir) {
	try {
		return parsePackageName(syncFs.readFileSync(path.join(dir, "package.json"), "utf-8"));
	} catch {
		return null;
	}
}
async function findPackageRoot(startDir, maxDepth = 12) {
	for (const current of iterAncestorDirs(startDir, maxDepth)) {
		const name = await readPackageName(current);
		if (name && CORE_PACKAGE_NAMES.has(name)) return current;
	}
	return null;
}
function findPackageRootSync(startDir, maxDepth = 12) {
	for (const current of iterAncestorDirs(startDir, maxDepth)) {
		const name = readPackageNameSync(current);
		if (name && CORE_PACKAGE_NAMES.has(name)) return current;
	}
	return null;
}
function* iterAncestorDirs(startDir, maxDepth) {
	let current = path.resolve(startDir);
	for (let i = 0; i < maxDepth; i += 1) {
		yield current;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
}
function candidateDirsFromArgv1(argv1) {
	const normalized = path.resolve(argv1);
	const candidates = [path.dirname(normalized)];
	try {
		const resolved = syncFs.realpathSync(normalized);
		if (resolved !== normalized) candidates.push(path.dirname(resolved));
	} catch {}
	const parts = normalized.split(path.sep);
	const binIndex = parts.lastIndexOf(".bin");
	if (binIndex > 0 && parts[binIndex - 1] === "node_modules") {
		const binName = path.basename(normalized);
		const nodeModulesDir = parts.slice(0, binIndex).join(path.sep);
		candidates.push(path.join(nodeModulesDir, binName));
	}
	return candidates;
}
async function resolveOpenClawPackageRoot(opts) {
	for (const candidate of buildCandidates(opts)) {
		const found = await findPackageRoot(candidate);
		if (found) return found;
	}
	return null;
}
function resolveOpenClawPackageRootSync(opts) {
	for (const candidate of buildCandidates(opts)) {
		const found = findPackageRootSync(candidate);
		if (found) return found;
	}
	return null;
}
function buildCandidates(opts) {
	const candidates = [];
	if (opts.moduleUrl) try {
		candidates.push(path.dirname(fileURLToPath(opts.moduleUrl)));
	} catch {}
	if (opts.argv1) candidates.push(...candidateDirsFromArgv1(opts.argv1));
	if (opts.cwd) candidates.push(opts.cwd);
	return candidates;
}
//#endregion
//#region src/agents/workspace-templates.ts
init_utils();
const FALLBACK_TEMPLATE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../docs/reference/templates");
let cachedTemplateDir;
let resolvingTemplateDir;
async function resolveWorkspaceTemplateDir(opts) {
	if (cachedTemplateDir) return cachedTemplateDir;
	if (resolvingTemplateDir) return resolvingTemplateDir;
	resolvingTemplateDir = (async () => {
		const moduleUrl = opts?.moduleUrl ?? import.meta.url;
		const argv1 = opts?.argv1 ?? process.argv[1];
		const cwd = opts?.cwd ?? process.cwd();
		const packageRoot = await resolveOpenClawPackageRoot({
			moduleUrl,
			argv1,
			cwd
		});
		const candidates = [
			packageRoot ? path.join(packageRoot, "docs", "reference", "templates") : null,
			cwd ? path.resolve(cwd, "docs", "reference", "templates") : null,
			FALLBACK_TEMPLATE_DIR
		].filter(Boolean);
		for (const candidate of candidates) if (await pathExists$1(candidate)) {
			cachedTemplateDir = candidate;
			return candidate;
		}
		cachedTemplateDir = candidates[0] ?? FALLBACK_TEMPLATE_DIR;
		return cachedTemplateDir;
	})();
	try {
		return await resolvingTemplateDir;
	} finally {
		resolvingTemplateDir = void 0;
	}
}
//#endregion
//#region src/agents/workspace.ts
init_home_dir();
init_session_key();
init_utils();
function resolveDefaultAgentWorkspaceDir(env = process.env, homedir = os.homedir) {
	const home = resolveRequiredHomeDir(env, homedir);
	const profile = env.OPENCLAW_PROFILE?.trim();
	if (profile && profile.toLowerCase() !== "default") return path.join(home, ".openclaw", `workspace-${profile}`);
	return path.join(home, ".openclaw", "workspace");
}
const DEFAULT_AGENT_WORKSPACE_DIR = resolveDefaultAgentWorkspaceDir();
const DEFAULT_AGENTS_FILENAME = "AGENTS.md";
const DEFAULT_SOUL_FILENAME = "SOUL.md";
const DEFAULT_TOOLS_FILENAME = "TOOLS.md";
const DEFAULT_IDENTITY_FILENAME = "IDENTITY.md";
const DEFAULT_USER_FILENAME = "USER.md";
const DEFAULT_HEARTBEAT_FILENAME = "HEARTBEAT.md";
const DEFAULT_BOOTSTRAP_FILENAME = "BOOTSTRAP.md";
const DEFAULT_MEMORY_FILENAME = "MEMORY.md";
const DEFAULT_MEMORY_ALT_FILENAME = "memory.md";
const WORKSPACE_STATE_DIRNAME = ".openclaw";
const WORKSPACE_STATE_FILENAME = "workspace-state.json";
const WORKSPACE_STATE_VERSION = 1;
const workspaceTemplateCache = /* @__PURE__ */ new Map();
let gitAvailabilityPromise = null;
const MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES = 2 * 1024 * 1024;
const workspaceFileCache = /* @__PURE__ */ new Map();
function workspaceFileIdentity(stat, canonicalPath) {
	return `${canonicalPath}|${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
}
async function readWorkspaceFileWithGuards(params) {
	const opened = await openBoundaryFile({
		absolutePath: params.filePath,
		rootPath: params.workspaceDir,
		boundaryLabel: "workspace root",
		maxBytes: MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES
	});
	if (!opened.ok) {
		workspaceFileCache.delete(params.filePath);
		return opened;
	}
	const identity = workspaceFileIdentity(opened.stat, opened.path);
	const cached = workspaceFileCache.get(params.filePath);
	if (cached && cached.identity === identity) {
		syncFs.closeSync(opened.fd);
		return {
			ok: true,
			content: cached.content
		};
	}
	try {
		const content = syncFs.readFileSync(opened.fd, "utf-8");
		workspaceFileCache.set(params.filePath, {
			content,
			identity
		});
		return {
			ok: true,
			content
		};
	} catch (error) {
		workspaceFileCache.delete(params.filePath);
		return {
			ok: false,
			reason: "io",
			error
		};
	} finally {
		syncFs.closeSync(opened.fd);
	}
}
function stripFrontMatter(content) {
	if (!content.startsWith("---")) return content;
	const endIndex = content.indexOf("\n---", 3);
	if (endIndex === -1) return content;
	const start = endIndex + 4;
	let trimmed = content.slice(start);
	trimmed = trimmed.replace(/^\s+/, "");
	return trimmed;
}
async function loadTemplate(name) {
	const cached = workspaceTemplateCache.get(name);
	if (cached) return cached;
	const pending = (async () => {
		const templateDir = await resolveWorkspaceTemplateDir();
		const templatePath = path.join(templateDir, name);
		try {
			return stripFrontMatter(await fs.readFile(templatePath, "utf-8"));
		} catch {
			throw new Error(`Missing workspace template: ${name} (${templatePath}). Ensure docs/reference/templates are packaged.`);
		}
	})();
	workspaceTemplateCache.set(name, pending);
	try {
		return await pending;
	} catch (error) {
		workspaceTemplateCache.delete(name);
		throw error;
	}
}
/** Set of recognized bootstrap filenames for runtime validation */
const VALID_BOOTSTRAP_NAMES = new Set([
	DEFAULT_AGENTS_FILENAME,
	DEFAULT_SOUL_FILENAME,
	DEFAULT_TOOLS_FILENAME,
	DEFAULT_IDENTITY_FILENAME,
	DEFAULT_USER_FILENAME,
	DEFAULT_HEARTBEAT_FILENAME,
	DEFAULT_BOOTSTRAP_FILENAME,
	DEFAULT_MEMORY_FILENAME,
	DEFAULT_MEMORY_ALT_FILENAME
]);
async function writeFileIfMissing(filePath, content) {
	try {
		await fs.writeFile(filePath, content, {
			encoding: "utf-8",
			flag: "wx"
		});
		return true;
	} catch (err) {
		if (err.code !== "EEXIST") throw err;
		return false;
	}
}
async function fileExists(filePath) {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}
function resolveWorkspaceStatePath(dir) {
	return path.join(dir, WORKSPACE_STATE_DIRNAME, WORKSPACE_STATE_FILENAME);
}
function parseWorkspaceSetupState(raw) {
	try {
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return null;
		const legacyCompletedAt = typeof parsed.onboardingCompletedAt === "string" ? parsed.onboardingCompletedAt : void 0;
		return {
			version: WORKSPACE_STATE_VERSION,
			bootstrapSeededAt: typeof parsed.bootstrapSeededAt === "string" ? parsed.bootstrapSeededAt : void 0,
			setupCompletedAt: typeof parsed.setupCompletedAt === "string" ? parsed.setupCompletedAt : legacyCompletedAt
		};
	} catch {
		return null;
	}
}
async function readWorkspaceSetupState(statePath) {
	try {
		const raw = await fs.readFile(statePath, "utf-8");
		const parsed = parseWorkspaceSetupState(raw);
		if (parsed && raw.includes("\"onboardingCompletedAt\"") && !raw.includes("\"setupCompletedAt\"") && parsed.setupCompletedAt) await writeWorkspaceSetupState(statePath, parsed);
		return parsed ?? { version: WORKSPACE_STATE_VERSION };
	} catch (err) {
		if (err.code !== "ENOENT") throw err;
		return { version: WORKSPACE_STATE_VERSION };
	}
}
async function writeWorkspaceSetupState(statePath, state) {
	await fs.mkdir(path.dirname(statePath), { recursive: true });
	const payload = `${JSON.stringify(state, null, 2)}\n`;
	const tmpPath = `${statePath}.tmp-${process.pid}-${Date.now().toString(36)}`;
	try {
		await fs.writeFile(tmpPath, payload, { encoding: "utf-8" });
		await fs.rename(tmpPath, statePath);
	} catch (err) {
		await fs.unlink(tmpPath).catch(() => {});
		throw err;
	}
}
async function hasGitRepo(dir) {
	try {
		await fs.stat(path.join(dir, ".git"));
		return true;
	} catch {
		return false;
	}
}
async function isGitAvailable() {
	if (gitAvailabilityPromise) return gitAvailabilityPromise;
	gitAvailabilityPromise = (async () => {
		try {
			return (await runCommandWithTimeout(["git", "--version"], { timeoutMs: 2e3 })).code === 0;
		} catch {
			return false;
		}
	})();
	return gitAvailabilityPromise;
}
async function ensureGitRepo(dir, isBrandNewWorkspace) {
	if (!isBrandNewWorkspace) return;
	if (await hasGitRepo(dir)) return;
	if (!await isGitAvailable()) return;
	try {
		await runCommandWithTimeout(["git", "init"], {
			cwd: dir,
			timeoutMs: 1e4
		});
	} catch {}
}
async function ensureAgentWorkspace(params) {
	const dir = resolveUserPath(params?.dir?.trim() ? params.dir.trim() : DEFAULT_AGENT_WORKSPACE_DIR);
	await fs.mkdir(dir, { recursive: true });
	if (!params?.ensureBootstrapFiles) return { dir };
	const agentsPath = path.join(dir, DEFAULT_AGENTS_FILENAME);
	const soulPath = path.join(dir, DEFAULT_SOUL_FILENAME);
	const toolsPath = path.join(dir, DEFAULT_TOOLS_FILENAME);
	const identityPath = path.join(dir, DEFAULT_IDENTITY_FILENAME);
	const userPath = path.join(dir, DEFAULT_USER_FILENAME);
	const heartbeatPath = path.join(dir, DEFAULT_HEARTBEAT_FILENAME);
	const bootstrapPath = path.join(dir, DEFAULT_BOOTSTRAP_FILENAME);
	const statePath = resolveWorkspaceStatePath(dir);
	const isBrandNewWorkspace = await (async () => {
		const templatePaths = [
			agentsPath,
			soulPath,
			toolsPath,
			identityPath,
			userPath,
			heartbeatPath
		];
		const userContentPaths = [
			path.join(dir, "memory"),
			path.join(dir, DEFAULT_MEMORY_FILENAME),
			path.join(dir, ".git")
		];
		const paths = [...templatePaths, ...userContentPaths];
		return (await Promise.all(paths.map(async (p) => {
			try {
				await fs.access(p);
				return true;
			} catch {
				return false;
			}
		}))).every((v) => !v);
	})();
	const agentsTemplate = await loadTemplate(DEFAULT_AGENTS_FILENAME);
	const soulTemplate = await loadTemplate(DEFAULT_SOUL_FILENAME);
	const toolsTemplate = await loadTemplate(DEFAULT_TOOLS_FILENAME);
	const identityTemplate = await loadTemplate(DEFAULT_IDENTITY_FILENAME);
	const userTemplate = await loadTemplate(DEFAULT_USER_FILENAME);
	const heartbeatTemplate = await loadTemplate(DEFAULT_HEARTBEAT_FILENAME);
	await writeFileIfMissing(agentsPath, agentsTemplate);
	await writeFileIfMissing(soulPath, soulTemplate);
	await writeFileIfMissing(toolsPath, toolsTemplate);
	await writeFileIfMissing(identityPath, identityTemplate);
	await writeFileIfMissing(userPath, userTemplate);
	await writeFileIfMissing(heartbeatPath, heartbeatTemplate);
	let state = await readWorkspaceSetupState(statePath);
	let stateDirty = false;
	const markState = (next) => {
		state = {
			...state,
			...next
		};
		stateDirty = true;
	};
	const nowIso = () => (/* @__PURE__ */ new Date()).toISOString();
	let bootstrapExists = await fileExists(bootstrapPath);
	if (!state.bootstrapSeededAt && bootstrapExists) markState({ bootstrapSeededAt: nowIso() });
	if (!state.setupCompletedAt && state.bootstrapSeededAt && !bootstrapExists) markState({ setupCompletedAt: nowIso() });
	if (!state.bootstrapSeededAt && !state.setupCompletedAt && !bootstrapExists) {
		const [identityContent, userContent] = await Promise.all([fs.readFile(identityPath, "utf-8"), fs.readFile(userPath, "utf-8")]);
		const hasUserContent = await (async () => {
			const indicators = [
				path.join(dir, "memory"),
				path.join(dir, DEFAULT_MEMORY_FILENAME),
				path.join(dir, ".git")
			];
			for (const indicator of indicators) try {
				await fs.access(indicator);
				return true;
			} catch {}
			return false;
		})();
		if (identityContent !== identityTemplate || userContent !== userTemplate || hasUserContent) markState({ setupCompletedAt: nowIso() });
		else {
			if (!await writeFileIfMissing(bootstrapPath, await loadTemplate("BOOTSTRAP.md"))) bootstrapExists = await fileExists(bootstrapPath);
			else bootstrapExists = true;
			if (bootstrapExists && !state.bootstrapSeededAt) markState({ bootstrapSeededAt: nowIso() });
		}
	}
	if (stateDirty) await writeWorkspaceSetupState(statePath, state);
	await ensureGitRepo(dir, isBrandNewWorkspace);
	return {
		dir,
		agentsPath,
		soulPath,
		toolsPath,
		identityPath,
		userPath,
		heartbeatPath,
		bootstrapPath
	};
}
async function resolveMemoryBootstrapEntry(resolvedDir) {
	for (const name of [DEFAULT_MEMORY_FILENAME, DEFAULT_MEMORY_ALT_FILENAME]) {
		const filePath = path.join(resolvedDir, name);
		try {
			await fs.access(filePath);
			return {
				name,
				filePath
			};
		} catch {}
	}
	return null;
}
async function loadWorkspaceBootstrapFiles(dir) {
	const resolvedDir = resolveUserPath(dir);
	const entries = [
		{
			name: DEFAULT_AGENTS_FILENAME,
			filePath: path.join(resolvedDir, DEFAULT_AGENTS_FILENAME)
		},
		{
			name: DEFAULT_SOUL_FILENAME,
			filePath: path.join(resolvedDir, DEFAULT_SOUL_FILENAME)
		},
		{
			name: DEFAULT_TOOLS_FILENAME,
			filePath: path.join(resolvedDir, DEFAULT_TOOLS_FILENAME)
		},
		{
			name: DEFAULT_IDENTITY_FILENAME,
			filePath: path.join(resolvedDir, DEFAULT_IDENTITY_FILENAME)
		},
		{
			name: DEFAULT_USER_FILENAME,
			filePath: path.join(resolvedDir, DEFAULT_USER_FILENAME)
		},
		{
			name: DEFAULT_HEARTBEAT_FILENAME,
			filePath: path.join(resolvedDir, DEFAULT_HEARTBEAT_FILENAME)
		},
		{
			name: DEFAULT_BOOTSTRAP_FILENAME,
			filePath: path.join(resolvedDir, DEFAULT_BOOTSTRAP_FILENAME)
		}
	];
	const memoryEntry = await resolveMemoryBootstrapEntry(resolvedDir);
	if (memoryEntry) entries.push(memoryEntry);
	const result = [];
	for (const entry of entries) {
		const loaded = await readWorkspaceFileWithGuards({
			filePath: entry.filePath,
			workspaceDir: resolvedDir
		});
		if (loaded.ok) result.push({
			name: entry.name,
			path: entry.filePath,
			content: loaded.content,
			missing: false
		});
		else result.push({
			name: entry.name,
			path: entry.filePath,
			missing: true
		});
	}
	return result;
}
const MINIMAL_BOOTSTRAP_ALLOWLIST = new Set([
	DEFAULT_AGENTS_FILENAME,
	DEFAULT_TOOLS_FILENAME,
	DEFAULT_SOUL_FILENAME,
	DEFAULT_IDENTITY_FILENAME,
	DEFAULT_USER_FILENAME
]);
function filterBootstrapFilesForSession(files, sessionKey) {
	if (!sessionKey || !isSubagentSessionKey(sessionKey) && !isCronSessionKey(sessionKey)) return files;
	return files.filter((file) => MINIMAL_BOOTSTRAP_ALLOWLIST.has(file.name));
}
async function loadExtraBootstrapFilesWithDiagnostics(dir, extraPatterns) {
	if (!extraPatterns.length) return {
		files: [],
		diagnostics: []
	};
	const resolvedDir = resolveUserPath(dir);
	const resolvedPaths = /* @__PURE__ */ new Set();
	for (const pattern of extraPatterns) if (pattern.includes("*") || pattern.includes("?") || pattern.includes("{")) try {
		const matches = fs.glob(pattern, { cwd: resolvedDir });
		for await (const m of matches) resolvedPaths.add(m);
	} catch {
		resolvedPaths.add(pattern);
	}
	else resolvedPaths.add(pattern);
	const files = [];
	const diagnostics = [];
	for (const relPath of resolvedPaths) {
		const filePath = path.resolve(resolvedDir, relPath);
		const baseName = path.basename(relPath);
		if (!VALID_BOOTSTRAP_NAMES.has(baseName)) {
			diagnostics.push({
				path: filePath,
				reason: "invalid-bootstrap-filename",
				detail: `unsupported bootstrap basename: ${baseName}`
			});
			continue;
		}
		const loaded = await readWorkspaceFileWithGuards({
			filePath,
			workspaceDir: resolvedDir
		});
		if (loaded.ok) {
			files.push({
				name: baseName,
				path: filePath,
				content: loaded.content,
				missing: false
			});
			continue;
		}
		const reason = loaded.reason === "path" ? "missing" : loaded.reason === "validation" ? "security" : "io";
		diagnostics.push({
			path: filePath,
			reason,
			detail: loaded.error instanceof Error ? loaded.error.message : typeof loaded.error === "string" ? loaded.error : reason
		});
	}
	return {
		files,
		diagnostics
	};
}
//#endregion
export { normalizeOptionalAccountId as $, isNotFoundPathError as A, init_session_key as B, openBoundaryFileSync as C, resolveBoundaryPath as D, BOUNDARY_PATH_ALIAS_POLICIES as E, DEFAULT_MAIN_KEY as F, resolveThreadSessionKeys as G, normalizeAgentId as H, buildAgentMainSessionKey as I, toAgentRequestSessionKey as J, sanitizeAgentId as K, buildAgentPeerSessionKey as L, isSymlinkOpenError as M, normalizeWindowsPathForComparison as N, resolvePathViaExistingAncestorSync as O, DEFAULT_AGENT_ID as P, normalizeAccountId as Q, buildGroupHistoryKey as R, openBoundaryFile as S, sameFileIdentity$1 as T, normalizeMainKey as U, isValidAgentId as V, resolveAgentIdFromSessionKey as W, DEFAULT_ACCOUNT_ID as X, toAgentStoreSessionKey as Y, init_account_id as Z, runExec as _, DEFAULT_IDENTITY_FILENAME as a, isCronSessionKey as at, markOpenClawExecEnv as b, DEFAULT_USER_FILENAME as c, resolveThreadParentSessionKey as ct, loadExtraBootstrapFilesWithDiagnostics as d, isBlockedObjectKey as et, loadWorkspaceBootstrapFiles as f, runCommandWithTimeout as g, resolveOpenClawPackageRootSync as h, DEFAULT_HEARTBEAT_FILENAME as i, isAcpSessionKey as it, isPathInside as j, hasNodeErrorCode as k, ensureAgentWorkspace as l, resolveOpenClawPackageRoot as m, DEFAULT_AGENT_WORKSPACE_DIR as n, getSubagentDepth as nt, DEFAULT_SOUL_FILENAME as o, isSubagentSessionKey as ot, resolveDefaultAgentWorkspaceDir as p, scopedHeartbeatWakeOptions as q, DEFAULT_BOOTSTRAP_FILENAME as r, init_session_key_utils as rt, DEFAULT_TOOLS_FILENAME as s, parseAgentSessionKey as st, DEFAULT_AGENTS_FILENAME as t, deriveSessionChatType as tt, filterBootstrapFilesForSession as u, resolveWindowsCommandShim as v, openVerifiedFileSync as w, canUseBoundaryFileOpen as x, spawnWithFallback as y, classifySessionKeyShape as z };
