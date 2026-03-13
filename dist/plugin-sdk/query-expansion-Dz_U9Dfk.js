import { B as shouldLogVerbose, I as danger, J as resolveNodeRequireFromMeta, O as createSubsystemLogger, g as pathExists$1, i as logWarn, n as logError, t as logDebug, y as resolveUserPath } from "./logger-_x5WOezH.js";
import { c as resolveStateDir, d as resolveRequiredHomeDir, l as expandHomePrefix } from "./paths-D6tDENa_.js";
import { createRequire } from "node:module";
import path from "node:path";
import fs, { constants, readFileSync, statSync } from "node:fs";
import os from "node:os";
import { promisify } from "node:util";
import fs$1 from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import process$1 from "node:process";
import { fileURLToPath } from "node:url";
import crypto, { randomUUID } from "node:crypto";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";
import { fileTypeFromBuffer } from "file-type";
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
const THREAD_SESSION_MARKERS = [":thread:", ":topic:"];
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
//#endregion
//#region src/infra/prototype-keys.ts
const BLOCKED_OBJECT_KEYS = new Set([
	"__proto__",
	"prototype",
	"constructor"
]);
function isBlockedObjectKey(key) {
	return BLOCKED_OBJECT_KEYS.has(key);
}
//#endregion
//#region src/routing/account-id.ts
const DEFAULT_ACCOUNT_ID = "default";
const VALID_ID_RE$1 = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const INVALID_CHARS_RE$1 = /[^a-z0-9_-]+/g;
const LEADING_DASH_RE$1 = /^-+/;
const TRAILING_DASH_RE$1 = /-+$/;
const ACCOUNT_ID_CACHE_MAX = 512;
const normalizeAccountIdCache = /* @__PURE__ */ new Map();
const normalizeOptionalAccountIdCache = /* @__PURE__ */ new Map();
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
//#endregion
//#region src/routing/session-key.ts
const DEFAULT_AGENT_ID = "main";
const DEFAULT_MAIN_KEY = "main";
const VALID_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const INVALID_CHARS_RE = /[^a-z0-9_-]+/g;
const LEADING_DASH_RE = /^-+/;
const TRAILING_DASH_RE = /-+$/;
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
//#endregion
//#region src/shared/string-normalization.ts
function normalizeStringEntries(list) {
	return (list ?? []).map((entry) => String(entry).trim()).filter(Boolean);
}
function normalizeStringEntriesLower(list) {
	return normalizeStringEntries(list).map((entry) => entry.toLowerCase());
}
function normalizeHyphenSlug(raw) {
	const trimmed = raw?.trim().toLowerCase() ?? "";
	if (!trimmed) return "";
	return trimmed.replace(/\s+/g, "-").replace(/[^a-z0-9#@._+-]+/g, "-").replace(/-{2,}/g, "-").replace(/^[-.]+|[-.]+$/g, "");
}
function normalizeAtHashSlug(raw) {
	const trimmed = raw?.trim().toLowerCase() ?? "";
	if (!trimmed) return "";
	return trimmed.replace(/^[@#]+/, "").replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
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
	const ioFs = params.ioFs ?? fs;
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
//#region src/config/model-input.ts
function resolveAgentModelPrimaryValue(model) {
	if (typeof model === "string") return model.trim() || void 0;
	if (!model || typeof model !== "object") return;
	return model.primary?.trim() || void 0;
}
function resolveAgentModelFallbackValues(model) {
	if (!model || typeof model !== "object") return [];
	return Array.isArray(model.fallbacks) ? model.fallbacks : [];
}
function toAgentModelListLike(model) {
	if (typeof model === "string") {
		const primary = model.trim();
		return primary ? { primary } : void 0;
	}
	if (!model || typeof model !== "object") return;
	return model;
}
//#endregion
//#region src/agents/skills/filter.ts
function normalizeSkillFilter(skillFilter) {
	if (skillFilter === void 0) return;
	return normalizeStringEntries(skillFilter);
}
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
	const resolvedRoot = path.resolve(root);
	const resolvedTarget = path.resolve(target);
	if (process.platform === "win32") {
		const rootForCompare = normalizeWindowsPathForComparison(resolvedRoot);
		const targetForCompare = normalizeWindowsPathForComparison(resolvedTarget);
		const relative = path.win32.relative(rootForCompare, targetForCompare);
		return relative === "" || !relative.startsWith("..") && !path.win32.isAbsolute(relative);
	}
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
			read: (cursor) => fs$1.lstat(cursor)
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
			read: (cursor) => fs.lstatSync(cursor)
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
		const resolvedAncestor = path.resolve(await fs$1.realpath(cursor));
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
	while (!isFilesystemRoot(cursor) && !fs.existsSync(cursor)) {
		missingSuffix.unshift(path.basename(cursor));
		const parent = path.dirname(cursor);
		if (parent === cursor) break;
		cursor = parent;
	}
	if (!fs.existsSync(cursor)) return normalized;
	try {
		const resolvedAncestor = path.resolve(fs.realpathSync(cursor));
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
			kind: toResolvedKind(preserveFinalSymlink ? await fs$1.lstat(absolutePath) : await fs$1.stat(absolutePath))
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
			kind: toResolvedKind(preserveFinalSymlink ? fs.lstatSync(absolutePath) : fs.statSync(absolutePath))
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
	throw new Error(`Path resolves outside ${params.boundaryLabel} (${shortPath$1(params.rootCanonicalPath)}): ${shortPath$1(params.absolutePath)}`);
}
function pathEscapeError(params) {
	return /* @__PURE__ */ new Error(`Path escapes ${params.boundaryLabel} (${shortPath$1(params.rootPath)}): ${shortPath$1(params.absolutePath)}`);
}
function symlinkEscapeError(params) {
	return /* @__PURE__ */ new Error(`Symlink escapes ${params.boundaryLabel} (${shortPath$1(params.rootCanonicalPath)}): ${shortPath$1(params.symlinkPath)}`);
}
function shortPath$1(value) {
	const home = os.homedir();
	if (value.startsWith(home)) return `~${value.slice(home.length)}`;
	return value;
}
function isFilesystemRoot(candidate) {
	return path.parse(candidate).root === candidate;
}
async function pathExists(targetPath) {
	try {
		await fs$1.lstat(targetPath);
		return true;
	} catch (error) {
		if (isNotFoundPathError(error)) return false;
		throw error;
	}
}
async function resolveSymlinkHopPath(symlinkPath) {
	try {
		return path.resolve(await fs$1.realpath(symlinkPath));
	} catch (error) {
		if (!isNotFoundPathError(error)) throw error;
		const linkTarget = await fs$1.readlink(symlinkPath);
		return resolvePathViaExistingAncestor(path.resolve(path.dirname(symlinkPath), linkTarget));
	}
}
function resolveSymlinkHopPathSync(symlinkPath) {
	try {
		return path.resolve(fs.realpathSync(symlinkPath));
	} catch (error) {
		if (!isNotFoundPathError(error)) throw error;
		const linkTarget = fs.readlinkSync(symlinkPath);
		return resolvePathViaExistingAncestorSync(path.resolve(path.dirname(symlinkPath), linkTarget));
	}
}
//#endregion
//#region src/infra/boundary-file-read.ts
function canUseBoundaryFileOpen(ioFs) {
	return typeof ioFs.openSync === "function" && typeof ioFs.closeSync === "function" && typeof ioFs.fstatSync === "function" && typeof ioFs.lstatSync === "function" && typeof ioFs.realpathSync === "function" && typeof ioFs.readFileSync === "function" && typeof ioFs.constants === "object" && ioFs.constants !== null;
}
function openBoundaryFileSync(params) {
	const ioFs = params.ioFs ?? fs;
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
	const ioFs = params.ioFs ?? fs;
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
	if (!fs.existsSync(cliPath)) {
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
async function readPackageName(dir) {
	try {
		const raw = await fs$1.readFile(path.join(dir, "package.json"), "utf-8");
		const parsed = JSON.parse(raw);
		return typeof parsed.name === "string" ? parsed.name : null;
	} catch {
		return null;
	}
}
function readPackageNameSync(dir) {
	try {
		const raw = fs.readFileSync(path.join(dir, "package.json"), "utf-8");
		const parsed = JSON.parse(raw);
		return typeof parsed.name === "string" ? parsed.name : null;
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
		const resolved = fs.realpathSync(normalized);
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
		fs.closeSync(opened.fd);
		return {
			ok: true,
			content: cached.content
		};
	}
	try {
		const content = fs.readFileSync(opened.fd, "utf-8");
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
		fs.closeSync(opened.fd);
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
			return stripFrontMatter(await fs$1.readFile(templatePath, "utf-8"));
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
async function writeFileIfMissing(filePath, content) {
	try {
		await fs$1.writeFile(filePath, content, {
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
		await fs$1.access(filePath);
		return true;
	} catch {
		return false;
	}
}
function resolveWorkspaceStatePath(dir) {
	return path.join(dir, WORKSPACE_STATE_DIRNAME, WORKSPACE_STATE_FILENAME);
}
function parseWorkspaceOnboardingState(raw) {
	try {
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return null;
		return {
			version: WORKSPACE_STATE_VERSION,
			bootstrapSeededAt: typeof parsed.bootstrapSeededAt === "string" ? parsed.bootstrapSeededAt : void 0,
			onboardingCompletedAt: typeof parsed.onboardingCompletedAt === "string" ? parsed.onboardingCompletedAt : void 0
		};
	} catch {
		return null;
	}
}
async function readWorkspaceOnboardingState(statePath) {
	try {
		return parseWorkspaceOnboardingState(await fs$1.readFile(statePath, "utf-8")) ?? { version: WORKSPACE_STATE_VERSION };
	} catch (err) {
		if (err.code !== "ENOENT") throw err;
		return { version: WORKSPACE_STATE_VERSION };
	}
}
async function writeWorkspaceOnboardingState(statePath, state) {
	await fs$1.mkdir(path.dirname(statePath), { recursive: true });
	const payload = `${JSON.stringify(state, null, 2)}\n`;
	const tmpPath = `${statePath}.tmp-${process.pid}-${Date.now().toString(36)}`;
	try {
		await fs$1.writeFile(tmpPath, payload, { encoding: "utf-8" });
		await fs$1.rename(tmpPath, statePath);
	} catch (err) {
		await fs$1.unlink(tmpPath).catch(() => {});
		throw err;
	}
}
async function hasGitRepo(dir) {
	try {
		await fs$1.stat(path.join(dir, ".git"));
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
	await fs$1.mkdir(dir, { recursive: true });
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
				await fs$1.access(p);
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
	let state = await readWorkspaceOnboardingState(statePath);
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
	if (!state.onboardingCompletedAt && state.bootstrapSeededAt && !bootstrapExists) markState({ onboardingCompletedAt: nowIso() });
	if (!state.bootstrapSeededAt && !state.onboardingCompletedAt && !bootstrapExists) {
		const [identityContent, userContent] = await Promise.all([fs$1.readFile(identityPath, "utf-8"), fs$1.readFile(userPath, "utf-8")]);
		const hasUserContent = await (async () => {
			const indicators = [
				path.join(dir, "memory"),
				path.join(dir, DEFAULT_MEMORY_FILENAME),
				path.join(dir, ".git")
			];
			for (const indicator of indicators) try {
				await fs$1.access(indicator);
				return true;
			} catch {}
			return false;
		})();
		if (identityContent !== identityTemplate || userContent !== userTemplate || hasUserContent) markState({ onboardingCompletedAt: nowIso() });
		else {
			if (!await writeFileIfMissing(bootstrapPath, await loadTemplate("BOOTSTRAP.md"))) bootstrapExists = await fileExists(bootstrapPath);
			else bootstrapExists = true;
			if (bootstrapExists && !state.bootstrapSeededAt) markState({ bootstrapSeededAt: nowIso() });
		}
	}
	if (stateDirty) await writeWorkspaceOnboardingState(statePath, state);
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
async function resolveMemoryBootstrapEntries(resolvedDir) {
	const candidates = [DEFAULT_MEMORY_FILENAME, DEFAULT_MEMORY_ALT_FILENAME];
	const entries = [];
	for (const name of candidates) {
		const filePath = path.join(resolvedDir, name);
		try {
			await fs$1.access(filePath);
			entries.push({
				name,
				filePath
			});
		} catch {}
	}
	if (entries.length <= 1) return entries;
	const seen = /* @__PURE__ */ new Set();
	const deduped = [];
	for (const entry of entries) {
		let key = entry.filePath;
		try {
			key = await fs$1.realpath(entry.filePath);
		} catch {}
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(entry);
	}
	return deduped;
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
	entries.push(...await resolveMemoryBootstrapEntries(resolvedDir));
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
//#endregion
//#region src/agents/agent-scope.ts
const log$1 = createSubsystemLogger("agent-scope");
/** Strip null bytes from paths to prevent ENOTDIR errors. */
function stripNullBytes(s) {
	return s.replace(/\0/g, "");
}
let defaultAgentWarned = false;
function listAgentEntries(cfg) {
	const list = cfg.agents?.list;
	if (!Array.isArray(list)) return [];
	return list.filter((entry) => Boolean(entry && typeof entry === "object"));
}
function listAgentIds(cfg) {
	const agents = listAgentEntries(cfg);
	if (agents.length === 0) return [DEFAULT_AGENT_ID];
	const seen = /* @__PURE__ */ new Set();
	const ids = [];
	for (const entry of agents) {
		const id = normalizeAgentId(entry?.id);
		if (seen.has(id)) continue;
		seen.add(id);
		ids.push(id);
	}
	return ids.length > 0 ? ids : [DEFAULT_AGENT_ID];
}
function resolveDefaultAgentId(cfg) {
	const agents = listAgentEntries(cfg);
	if (agents.length === 0) return DEFAULT_AGENT_ID;
	const defaults = agents.filter((agent) => agent?.default);
	if (defaults.length > 1 && !defaultAgentWarned) {
		defaultAgentWarned = true;
		log$1.warn("Multiple agents marked default=true; using the first entry as default.");
	}
	const chosen = (defaults[0] ?? agents[0])?.id?.trim();
	return normalizeAgentId(chosen || "main");
}
function resolveSessionAgentIds(params) {
	const defaultAgentId = resolveDefaultAgentId(params.config ?? {});
	const explicitAgentIdRaw = typeof params.agentId === "string" ? params.agentId.trim().toLowerCase() : "";
	const explicitAgentId = explicitAgentIdRaw ? normalizeAgentId(explicitAgentIdRaw) : null;
	const sessionKey = params.sessionKey?.trim();
	const normalizedSessionKey = sessionKey ? sessionKey.toLowerCase() : void 0;
	const parsed = normalizedSessionKey ? parseAgentSessionKey(normalizedSessionKey) : null;
	return {
		defaultAgentId,
		sessionAgentId: explicitAgentId ?? (parsed?.agentId ? normalizeAgentId(parsed.agentId) : defaultAgentId)
	};
}
function resolveSessionAgentId(params) {
	return resolveSessionAgentIds(params).sessionAgentId;
}
function resolveAgentEntry(cfg, agentId) {
	const id = normalizeAgentId(agentId);
	return listAgentEntries(cfg).find((entry) => normalizeAgentId(entry.id) === id);
}
function resolveAgentConfig(cfg, agentId) {
	const entry = resolveAgentEntry(cfg, normalizeAgentId(agentId));
	if (!entry) return;
	return {
		name: typeof entry.name === "string" ? entry.name : void 0,
		workspace: typeof entry.workspace === "string" ? entry.workspace : void 0,
		agentDir: typeof entry.agentDir === "string" ? entry.agentDir : void 0,
		model: typeof entry.model === "string" || entry.model && typeof entry.model === "object" ? entry.model : void 0,
		skills: Array.isArray(entry.skills) ? entry.skills : void 0,
		memorySearch: entry.memorySearch,
		humanDelay: entry.humanDelay,
		heartbeat: entry.heartbeat,
		identity: entry.identity,
		groupChat: entry.groupChat,
		subagents: typeof entry.subagents === "object" && entry.subagents ? entry.subagents : void 0,
		sandbox: entry.sandbox,
		tools: entry.tools
	};
}
function resolveAgentSkillsFilter(cfg, agentId) {
	return normalizeSkillFilter(resolveAgentConfig(cfg, agentId)?.skills);
}
function resolveModelPrimary(raw) {
	if (typeof raw === "string") return raw.trim() || void 0;
	if (!raw || typeof raw !== "object") return;
	const primary = raw.primary;
	if (typeof primary !== "string") return;
	return primary.trim() || void 0;
}
function resolveAgentExplicitModelPrimary(cfg, agentId) {
	const raw = resolveAgentConfig(cfg, agentId)?.model;
	return resolveModelPrimary(raw);
}
function resolveAgentEffectiveModelPrimary(cfg, agentId) {
	return resolveAgentExplicitModelPrimary(cfg, agentId) ?? resolveModelPrimary(cfg.agents?.defaults?.model);
}
function resolveAgentModelFallbacksOverride(cfg, agentId) {
	const raw = resolveAgentConfig(cfg, agentId)?.model;
	if (!raw || typeof raw === "string") return;
	if (!Object.hasOwn(raw, "fallbacks")) return;
	return Array.isArray(raw.fallbacks) ? raw.fallbacks : void 0;
}
function resolveFallbackAgentId(params) {
	const explicitAgentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
	if (explicitAgentId) return normalizeAgentId(explicitAgentId);
	return resolveAgentIdFromSessionKey(params.sessionKey);
}
function resolveRunModelFallbacksOverride(params) {
	if (!params.cfg) return;
	return resolveAgentModelFallbacksOverride(params.cfg, resolveFallbackAgentId({
		agentId: params.agentId,
		sessionKey: params.sessionKey
	}));
}
function hasConfiguredModelFallbacks(params) {
	const fallbacksOverride = resolveRunModelFallbacksOverride(params);
	const defaultFallbacks = resolveAgentModelFallbackValues(params.cfg?.agents?.defaults?.model);
	return (fallbacksOverride ?? defaultFallbacks).length > 0;
}
function resolveEffectiveModelFallbacks(params) {
	const agentFallbacksOverride = resolveAgentModelFallbacksOverride(params.cfg, params.agentId);
	if (!params.hasSessionModelOverride) return agentFallbacksOverride;
	const defaultFallbacks = resolveAgentModelFallbackValues(params.cfg.agents?.defaults?.model);
	return agentFallbacksOverride ?? defaultFallbacks;
}
function resolveAgentWorkspaceDir(cfg, agentId) {
	const id = normalizeAgentId(agentId);
	const configured = resolveAgentConfig(cfg, id)?.workspace?.trim();
	if (configured) return stripNullBytes(resolveUserPath(configured));
	if (id === resolveDefaultAgentId(cfg)) {
		const fallback = cfg.agents?.defaults?.workspace?.trim();
		if (fallback) return stripNullBytes(resolveUserPath(fallback));
		return stripNullBytes(resolveDefaultAgentWorkspaceDir(process.env));
	}
	const stateDir = resolveStateDir(process.env);
	return stripNullBytes(path.join(stateDir, `workspace-${id}`));
}
function resolveAgentDir(cfg, agentId) {
	const id = normalizeAgentId(agentId);
	const configured = resolveAgentConfig(cfg, id)?.agentDir?.trim();
	if (configured) return resolveUserPath(configured);
	const root = resolveStateDir(process.env);
	return path.join(root, "agents", id, "agent");
}
//#endregion
//#region src/utils/run-with-concurrency.ts
async function runTasksWithConcurrency(params) {
	const { tasks, limit, onTaskError } = params;
	const errorMode = params.errorMode ?? "continue";
	if (tasks.length === 0) return {
		results: [],
		firstError: void 0,
		hasError: false
	};
	const resolvedLimit = Math.max(1, Math.min(limit, tasks.length));
	const results = Array.from({ length: tasks.length });
	let next = 0;
	let firstError = void 0;
	let hasError = false;
	const workers = Array.from({ length: resolvedLimit }, async () => {
		while (true) {
			if (errorMode === "stop" && hasError) return;
			const index = next;
			next += 1;
			if (index >= tasks.length) return;
			try {
				results[index] = await tasks[index]();
			} catch (error) {
				if (!hasError) {
					firstError = error;
					hasError = true;
				}
				onTaskError?.(error, index);
				if (errorMode === "stop") return;
			}
		}
	});
	await Promise.allSettled(workers);
	return {
		results,
		firstError,
		hasError
	};
}
//#endregion
//#region src/security/safe-regex.ts
const SAFE_REGEX_CACHE_MAX = 256;
const SAFE_REGEX_TEST_WINDOW = 2048;
const safeRegexCache = /* @__PURE__ */ new Map();
function createParseFrame() {
	return {
		lastToken: null,
		containsRepetition: false,
		hasAlternation: false,
		branchMinLength: 0,
		branchMaxLength: 0,
		altMinLength: null,
		altMaxLength: null
	};
}
function addLength(left, right) {
	if (!Number.isFinite(left) || !Number.isFinite(right)) return Number.POSITIVE_INFINITY;
	return left + right;
}
function multiplyLength(length, factor) {
	if (!Number.isFinite(length)) return factor === 0 ? 0 : Number.POSITIVE_INFINITY;
	return length * factor;
}
function recordAlternative(frame) {
	if (frame.altMinLength === null || frame.altMaxLength === null) {
		frame.altMinLength = frame.branchMinLength;
		frame.altMaxLength = frame.branchMaxLength;
		return;
	}
	frame.altMinLength = Math.min(frame.altMinLength, frame.branchMinLength);
	frame.altMaxLength = Math.max(frame.altMaxLength, frame.branchMaxLength);
}
function readQuantifier(source, index) {
	const ch = source[index];
	const consumed = source[index + 1] === "?" ? 2 : 1;
	if (ch === "*") return {
		consumed,
		minRepeat: 0,
		maxRepeat: null
	};
	if (ch === "+") return {
		consumed,
		minRepeat: 1,
		maxRepeat: null
	};
	if (ch === "?") return {
		consumed,
		minRepeat: 0,
		maxRepeat: 1
	};
	if (ch !== "{") return null;
	let i = index + 1;
	while (i < source.length && /\d/.test(source[i])) i += 1;
	if (i === index + 1) return null;
	const minRepeat = Number.parseInt(source.slice(index + 1, i), 10);
	let maxRepeat = minRepeat;
	if (source[i] === ",") {
		i += 1;
		const maxStart = i;
		while (i < source.length && /\d/.test(source[i])) i += 1;
		maxRepeat = i === maxStart ? null : Number.parseInt(source.slice(maxStart, i), 10);
	}
	if (source[i] !== "}") return null;
	i += 1;
	if (source[i] === "?") i += 1;
	if (maxRepeat !== null && maxRepeat < minRepeat) return null;
	return {
		consumed: i - index,
		minRepeat,
		maxRepeat
	};
}
function tokenizePattern(source) {
	const tokens = [];
	let inCharClass = false;
	for (let i = 0; i < source.length; i += 1) {
		const ch = source[i];
		if (ch === "\\") {
			i += 1;
			tokens.push({ kind: "simple-token" });
			continue;
		}
		if (inCharClass) {
			if (ch === "]") inCharClass = false;
			continue;
		}
		if (ch === "[") {
			inCharClass = true;
			tokens.push({ kind: "simple-token" });
			continue;
		}
		if (ch === "(") {
			tokens.push({ kind: "group-open" });
			continue;
		}
		if (ch === ")") {
			tokens.push({ kind: "group-close" });
			continue;
		}
		if (ch === "|") {
			tokens.push({ kind: "alternation" });
			continue;
		}
		const quantifier = readQuantifier(source, i);
		if (quantifier) {
			tokens.push({
				kind: "quantifier",
				quantifier
			});
			i += quantifier.consumed - 1;
			continue;
		}
		tokens.push({ kind: "simple-token" });
	}
	return tokens;
}
function analyzeTokensForNestedRepetition(tokens) {
	const frames = [createParseFrame()];
	const emitToken = (token) => {
		const frame = frames[frames.length - 1];
		frame.lastToken = token;
		if (token.containsRepetition) frame.containsRepetition = true;
		frame.branchMinLength = addLength(frame.branchMinLength, token.minLength);
		frame.branchMaxLength = addLength(frame.branchMaxLength, token.maxLength);
	};
	const emitSimpleToken = () => {
		emitToken({
			containsRepetition: false,
			hasAmbiguousAlternation: false,
			minLength: 1,
			maxLength: 1
		});
	};
	for (const token of tokens) {
		if (token.kind === "simple-token") {
			emitSimpleToken();
			continue;
		}
		if (token.kind === "group-open") {
			frames.push(createParseFrame());
			continue;
		}
		if (token.kind === "group-close") {
			if (frames.length > 1) {
				const frame = frames.pop();
				if (frame.hasAlternation) recordAlternative(frame);
				const groupMinLength = frame.hasAlternation ? frame.altMinLength ?? 0 : frame.branchMinLength;
				const groupMaxLength = frame.hasAlternation ? frame.altMaxLength ?? 0 : frame.branchMaxLength;
				emitToken({
					containsRepetition: frame.containsRepetition,
					hasAmbiguousAlternation: frame.hasAlternation && frame.altMinLength !== null && frame.altMaxLength !== null && frame.altMinLength !== frame.altMaxLength,
					minLength: groupMinLength,
					maxLength: groupMaxLength
				});
			}
			continue;
		}
		if (token.kind === "alternation") {
			const frame = frames[frames.length - 1];
			frame.hasAlternation = true;
			recordAlternative(frame);
			frame.branchMinLength = 0;
			frame.branchMaxLength = 0;
			frame.lastToken = null;
			continue;
		}
		const frame = frames[frames.length - 1];
		const previousToken = frame.lastToken;
		if (!previousToken) continue;
		if (previousToken.containsRepetition) return true;
		if (previousToken.hasAmbiguousAlternation && token.quantifier.maxRepeat === null) return true;
		const previousMinLength = previousToken.minLength;
		const previousMaxLength = previousToken.maxLength;
		previousToken.minLength = multiplyLength(previousToken.minLength, token.quantifier.minRepeat);
		previousToken.maxLength = token.quantifier.maxRepeat === null ? Number.POSITIVE_INFINITY : multiplyLength(previousToken.maxLength, token.quantifier.maxRepeat);
		previousToken.containsRepetition = true;
		frame.containsRepetition = true;
		frame.branchMinLength = frame.branchMinLength - previousMinLength + previousToken.minLength;
		frame.branchMaxLength = addLength(Number.isFinite(frame.branchMaxLength) && Number.isFinite(previousMaxLength) ? frame.branchMaxLength - previousMaxLength : Number.POSITIVE_INFINITY, previousToken.maxLength);
	}
	return false;
}
function testRegexFromStart(regex, value) {
	regex.lastIndex = 0;
	return regex.test(value);
}
function testRegexWithBoundedInput(regex, input, maxWindow = SAFE_REGEX_TEST_WINDOW) {
	if (maxWindow <= 0) return false;
	if (input.length <= maxWindow) return testRegexFromStart(regex, input);
	if (testRegexFromStart(regex, input.slice(0, maxWindow))) return true;
	return testRegexFromStart(regex, input.slice(-maxWindow));
}
function hasNestedRepetition(source) {
	return analyzeTokensForNestedRepetition(tokenizePattern(source));
}
function compileSafeRegex(source, flags = "") {
	const trimmed = source.trim();
	if (!trimmed) return null;
	const cacheKey = `${flags}::${trimmed}`;
	if (safeRegexCache.has(cacheKey)) return safeRegexCache.get(cacheKey) ?? null;
	let compiled = null;
	if (!hasNestedRepetition(trimmed)) try {
		compiled = new RegExp(trimmed, flags);
	} catch {
		compiled = null;
	}
	safeRegexCache.set(cacheKey, compiled);
	if (safeRegexCache.size > SAFE_REGEX_CACHE_MAX) {
		const oldestKey = safeRegexCache.keys().next().value;
		if (oldestKey) safeRegexCache.delete(oldestKey);
	}
	return compiled;
}
function replacePatternBounded(text, pattern, replacer, options) {
	const chunkThreshold = options?.chunkThreshold ?? 32768;
	const chunkSize = options?.chunkSize ?? 16384;
	if (chunkThreshold <= 0 || chunkSize <= 0 || text.length <= chunkThreshold) return text.replace(pattern, replacer);
	let output = "";
	for (let index = 0; index < text.length; index += chunkSize) output += text.slice(index, index + chunkSize).replace(pattern, replacer);
	return output;
}
//#endregion
//#region src/logging/redact.ts
const requireConfig = resolveNodeRequireFromMeta(import.meta.url);
const DEFAULT_REDACT_MODE = "tools";
const DEFAULT_REDACT_MIN_LENGTH = 18;
const DEFAULT_REDACT_KEEP_START = 6;
const DEFAULT_REDACT_KEEP_END = 4;
const DEFAULT_REDACT_PATTERNS = [
	String.raw`\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)\b\s*[=:]\s*(["']?)([^\s"'\\]+)\1`,
	String.raw`"(?:apiKey|token|secret|password|passwd|accessToken|refreshToken)"\s*:\s*"([^"]+)"`,
	String.raw`--(?:api[-_]?key|token|secret|password|passwd)\s+(["']?)([^\s"']+)\1`,
	String.raw`Authorization\s*[:=]\s*Bearer\s+([A-Za-z0-9._\-+=]+)`,
	String.raw`\bBearer\s+([A-Za-z0-9._\-+=]{18,})\b`,
	String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----`,
	String.raw`\b(sk-[A-Za-z0-9_-]{8,})\b`,
	String.raw`\b(ghp_[A-Za-z0-9]{20,})\b`,
	String.raw`\b(github_pat_[A-Za-z0-9_]{20,})\b`,
	String.raw`\b(xox[baprs]-[A-Za-z0-9-]{10,})\b`,
	String.raw`\b(xapp-[A-Za-z0-9-]{10,})\b`,
	String.raw`\b(gsk_[A-Za-z0-9_-]{10,})\b`,
	String.raw`\b(AIza[0-9A-Za-z\-_]{20,})\b`,
	String.raw`\b(pplx-[A-Za-z0-9_-]{10,})\b`,
	String.raw`\b(npm_[A-Za-z0-9]{10,})\b`,
	String.raw`\bbot(\d{6,}:[A-Za-z0-9_-]{20,})\b`,
	String.raw`\b(\d{6,}:[A-Za-z0-9_-]{20,})\b`
];
function normalizeMode(value) {
	return value === "off" ? "off" : DEFAULT_REDACT_MODE;
}
function parsePattern(raw) {
	if (!raw.trim()) return null;
	const match = raw.match(/^\/(.+)\/([gimsuy]*)$/);
	if (match) {
		const flags = match[2].includes("g") ? match[2] : `${match[2]}g`;
		return compileSafeRegex(match[1], flags);
	}
	return compileSafeRegex(raw, "gi");
}
function resolvePatterns(value) {
	return (value?.length ? value : DEFAULT_REDACT_PATTERNS).map(parsePattern).filter((re) => Boolean(re));
}
function maskToken(token) {
	if (token.length < DEFAULT_REDACT_MIN_LENGTH) return "***";
	return `${token.slice(0, DEFAULT_REDACT_KEEP_START)}…${token.slice(-DEFAULT_REDACT_KEEP_END)}`;
}
function redactPemBlock(block) {
	const lines = block.split(/\r?\n/).filter(Boolean);
	if (lines.length < 2) return "***";
	return `${lines[0]}\n…redacted…\n${lines[lines.length - 1]}`;
}
function redactMatch(match, groups) {
	if (match.includes("PRIVATE KEY-----")) return redactPemBlock(match);
	const token = groups.filter((value) => typeof value === "string" && value.length > 0).at(-1) ?? match;
	const masked = maskToken(token);
	if (token === match) return masked;
	return match.replace(token, masked);
}
function redactText(text, patterns) {
	let next = text;
	for (const pattern of patterns) next = replacePatternBounded(next, pattern, (...args) => redactMatch(args[0], args.slice(1, args.length - 2)));
	return next;
}
function resolveConfigRedaction() {
	let cfg;
	try {
		cfg = (requireConfig?.("../config/config.js"))?.loadConfig?.().logging;
	} catch {
		cfg = void 0;
	}
	return {
		mode: normalizeMode(cfg?.redactSensitive),
		patterns: cfg?.redactPatterns
	};
}
function redactSensitiveText(text, options) {
	if (!text) return text;
	const resolved = options ?? resolveConfigRedaction();
	if (normalizeMode(resolved.mode) === "off") return text;
	const patterns = resolvePatterns(resolved.patterns);
	if (!patterns.length) return text;
	return redactText(text, patterns);
}
function redactToolDetail(detail) {
	const resolved = resolveConfigRedaction();
	if (normalizeMode(resolved.mode) !== "tools") return detail;
	return redactSensitiveText(detail, resolved);
}
function getDefaultRedactPatterns() {
	return [...DEFAULT_REDACT_PATTERNS];
}
//#endregion
//#region src/infra/hardlink-guards.ts
async function assertNoHardlinkedFinalPath(params) {
	if (params.allowFinalHardlinkForUnlink) return;
	let stat;
	try {
		stat = await fs$1.stat(params.filePath);
	} catch (err) {
		if (isNotFoundPathError(err)) return;
		throw err;
	}
	if (!stat.isFile()) return;
	if (stat.nlink > 1) throw new Error(`Hardlinked path is not allowed under ${params.boundaryLabel} (${shortPath(params.root)}): ${shortPath(params.filePath)}`);
}
function shortPath(value) {
	if (value.startsWith(os.homedir())) return `~${value.slice(os.homedir().length)}`;
	return value;
}
//#endregion
//#region src/infra/path-alias-guards.ts
const PATH_ALIAS_POLICIES = BOUNDARY_PATH_ALIAS_POLICIES;
async function assertNoPathAliasEscape(params) {
	const resolved = await resolveBoundaryPath({
		absolutePath: params.absolutePath,
		rootPath: params.rootPath,
		boundaryLabel: params.boundaryLabel,
		policy: params.policy
	});
	if (params.policy?.allowFinalSymlinkForUnlink === true && resolved.kind === "symlink") return;
	await assertNoHardlinkedFinalPath({
		filePath: resolved.absolutePath,
		root: resolved.rootPath,
		boundaryLabel: params.boundaryLabel,
		allowFinalHardlinkForUnlink: params.policy?.allowFinalHardlinkForUnlink
	});
}
//#endregion
//#region src/infra/fs-pinned-write-helper.ts
const LOCAL_PINNED_WRITE_PYTHON = [
	"import errno",
	"import os",
	"import secrets",
	"import stat",
	"import sys",
	"",
	"root_path = sys.argv[1]",
	"relative_parent = sys.argv[2]",
	"basename = sys.argv[3]",
	"mkdir_enabled = sys.argv[4] == \"1\"",
	"file_mode = int(sys.argv[5], 8)",
	"",
	"DIR_FLAGS = os.O_RDONLY",
	"if hasattr(os, 'O_DIRECTORY'):",
	"    DIR_FLAGS |= os.O_DIRECTORY",
	"if hasattr(os, 'O_NOFOLLOW'):",
	"    DIR_FLAGS |= os.O_NOFOLLOW",
	"",
	"WRITE_FLAGS = os.O_WRONLY | os.O_CREAT | os.O_EXCL",
	"if hasattr(os, 'O_NOFOLLOW'):",
	"    WRITE_FLAGS |= os.O_NOFOLLOW",
	"",
	"def open_dir(path_value, dir_fd=None):",
	"    return os.open(path_value, DIR_FLAGS, dir_fd=dir_fd)",
	"",
	"def walk_parent(root_fd, rel_parent, mkdir_enabled):",
	"    current_fd = os.dup(root_fd)",
	"    try:",
	"        for segment in [part for part in rel_parent.split('/') if part and part != '.']:",
	"            if segment == '..':",
	"                raise OSError(errno.EPERM, 'path traversal is not allowed', segment)",
	"            try:",
	"                next_fd = open_dir(segment, dir_fd=current_fd)",
	"            except FileNotFoundError:",
	"                if not mkdir_enabled:",
	"                    raise",
	"                os.mkdir(segment, 0o777, dir_fd=current_fd)",
	"                next_fd = open_dir(segment, dir_fd=current_fd)",
	"            os.close(current_fd)",
	"            current_fd = next_fd",
	"        return current_fd",
	"    except Exception:",
	"        os.close(current_fd)",
	"        raise",
	"",
	"def create_temp_file(parent_fd, basename, mode):",
	"    prefix = '.' + basename + '.'",
	"    for _ in range(128):",
	"        candidate = prefix + secrets.token_hex(6) + '.tmp'",
	"        try:",
	"            fd = os.open(candidate, WRITE_FLAGS, mode, dir_fd=parent_fd)",
	"            return candidate, fd",
	"        except FileExistsError:",
	"            continue",
	"    raise RuntimeError('failed to allocate pinned temp file')",
	"",
	"root_fd = open_dir(root_path)",
	"parent_fd = None",
	"temp_fd = None",
	"temp_name = None",
	"try:",
	"    parent_fd = walk_parent(root_fd, relative_parent, mkdir_enabled)",
	"    temp_name, temp_fd = create_temp_file(parent_fd, basename, file_mode)",
	"    while True:",
	"        chunk = sys.stdin.buffer.read(65536)",
	"        if not chunk:",
	"            break",
	"        os.write(temp_fd, chunk)",
	"    os.fsync(temp_fd)",
	"    os.close(temp_fd)",
	"    temp_fd = None",
	"    os.replace(temp_name, basename, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)",
	"    temp_name = None",
	"    os.fsync(parent_fd)",
	"    result_stat = os.stat(basename, dir_fd=parent_fd, follow_symlinks=False)",
	"    print(f'{result_stat.st_dev}|{result_stat.st_ino}')",
	"finally:",
	"    if temp_fd is not None:",
	"        os.close(temp_fd)",
	"    if temp_name is not None and parent_fd is not None:",
	"        try:",
	"            os.unlink(temp_name, dir_fd=parent_fd)",
	"        except FileNotFoundError:",
	"            pass",
	"    if parent_fd is not None:",
	"        os.close(parent_fd)",
	"    os.close(root_fd)"
].join("\n");
function parsePinnedIdentity(stdout) {
	const line = stdout.trim().split(/\r?\n/).map((value) => value.trim()).filter(Boolean).at(-1);
	if (!line) throw new Error("Pinned write helper returned no identity");
	const [devRaw, inoRaw] = line.split("|");
	const dev = Number.parseInt(devRaw ?? "", 10);
	const ino = Number.parseInt(inoRaw ?? "", 10);
	if (!Number.isFinite(dev) || !Number.isFinite(ino)) throw new Error(`Pinned write helper returned invalid identity: ${line}`);
	return {
		dev,
		ino
	};
}
async function runPinnedWriteHelper(params) {
	const child = spawn("python3", [
		"-c",
		LOCAL_PINNED_WRITE_PYTHON,
		params.rootPath,
		params.relativeParentPath,
		params.basename,
		params.mkdir ? "1" : "0",
		(params.mode || 384).toString(8)
	], { stdio: [
		"pipe",
		"pipe",
		"pipe"
	] });
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding?.("utf8");
	child.stderr.setEncoding?.("utf8");
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const exitPromise = once(child, "close");
	try {
		if (!child.stdin) {
			const identity = await runPinnedWriteFallback(params);
			await exitPromise.catch(() => {});
			return identity;
		}
		if (params.input.kind === "buffer") {
			const input = params.input;
			await new Promise((resolve, reject) => {
				child.stdin.once("error", reject);
				if (typeof input.data === "string") {
					child.stdin.end(input.data, input.encoding ?? "utf8", () => resolve());
					return;
				}
				child.stdin.end(input.data, () => resolve());
			});
		} else await pipeline(params.input.stream, child.stdin);
		const [code, signal] = await exitPromise;
		if (code !== 0) throw new Error(stderr.trim() || `Pinned write helper failed with code ${code ?? "null"} (${signal ?? "?"})`);
		return parsePinnedIdentity(stdout);
	} catch (error) {
		child.kill("SIGKILL");
		await exitPromise.catch(() => {});
		throw error;
	}
}
async function runPinnedWriteFallback(params) {
	const parentPath = params.relativeParentPath ? path.join(params.rootPath, ...params.relativeParentPath.split("/")) : params.rootPath;
	if (params.mkdir) await fs$1.mkdir(parentPath, { recursive: true });
	const targetPath = path.join(parentPath, params.basename);
	const tempPath = path.join(parentPath, `.${params.basename}.fallback.tmp`);
	if (params.input.kind === "buffer") if (typeof params.input.data === "string") await fs$1.writeFile(tempPath, params.input.data, {
		encoding: params.input.encoding ?? "utf8",
		mode: params.mode
	});
	else await fs$1.writeFile(tempPath, params.input.data, { mode: params.mode });
	else {
		const handle = await fs$1.open(tempPath, "w", params.mode);
		try {
			await pipeline(params.input.stream, handle.createWriteStream());
		} finally {
			await handle.close().catch(() => {});
		}
	}
	await fs$1.rename(tempPath, targetPath);
	const stat = await fs$1.stat(targetPath);
	return {
		dev: stat.dev,
		ino: stat.ino
	};
}
//#endregion
//#region src/infra/fs-safe.ts
var SafeOpenError = class extends Error {
	constructor(code, message, options) {
		super(message, options);
		this.code = code;
		this.name = "SafeOpenError";
	}
};
const SUPPORTS_NOFOLLOW = process.platform !== "win32" && "O_NOFOLLOW" in constants;
const OPEN_READ_FLAGS = constants.O_RDONLY | (SUPPORTS_NOFOLLOW ? constants.O_NOFOLLOW : 0);
const OPEN_WRITE_EXISTING_FLAGS = constants.O_WRONLY | (SUPPORTS_NOFOLLOW ? constants.O_NOFOLLOW : 0);
const OPEN_WRITE_CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (SUPPORTS_NOFOLLOW ? constants.O_NOFOLLOW : 0);
const OPEN_APPEND_EXISTING_FLAGS = constants.O_RDWR | constants.O_APPEND | (SUPPORTS_NOFOLLOW ? constants.O_NOFOLLOW : 0);
const OPEN_APPEND_CREATE_FLAGS = constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | (SUPPORTS_NOFOLLOW ? constants.O_NOFOLLOW : 0);
const ensureTrailingSep = (value) => value.endsWith(path.sep) ? value : value + path.sep;
async function expandRelativePathWithHome(relativePath) {
	let home = process.env.HOME || process.env.USERPROFILE || os.homedir();
	try {
		home = await fs$1.realpath(home);
	} catch {}
	return expandHomePrefix(relativePath, { home });
}
async function openVerifiedLocalFile(filePath, options) {
	try {
		if ((await fs$1.lstat(filePath)).isDirectory()) throw new SafeOpenError("not-file", "not a file");
	} catch (err) {
		if (err instanceof SafeOpenError) throw err;
	}
	let handle;
	try {
		handle = await fs$1.open(filePath, OPEN_READ_FLAGS);
	} catch (err) {
		if (isNotFoundPathError(err)) throw new SafeOpenError("not-found", "file not found");
		if (isSymlinkOpenError(err)) throw new SafeOpenError("symlink", "symlink open blocked", { cause: err });
		if (hasNodeErrorCode(err, "EISDIR")) throw new SafeOpenError("not-file", "not a file");
		throw err;
	}
	try {
		const [stat, lstat] = await Promise.all([handle.stat(), fs$1.lstat(filePath)]);
		if (lstat.isSymbolicLink()) throw new SafeOpenError("symlink", "symlink not allowed");
		if (!stat.isFile()) throw new SafeOpenError("not-file", "not a file");
		if (options?.rejectHardlinks && stat.nlink > 1) throw new SafeOpenError("invalid-path", "hardlinked path not allowed");
		if (!sameFileIdentity$1(stat, lstat)) throw new SafeOpenError("path-mismatch", "path changed during read");
		const realPath = await fs$1.realpath(filePath);
		const realStat = await fs$1.stat(realPath);
		if (options?.rejectHardlinks && realStat.nlink > 1) throw new SafeOpenError("invalid-path", "hardlinked path not allowed");
		if (!sameFileIdentity$1(stat, realStat)) throw new SafeOpenError("path-mismatch", "path mismatch");
		return {
			handle,
			realPath,
			stat
		};
	} catch (err) {
		await handle.close().catch(() => {});
		if (err instanceof SafeOpenError) throw err;
		if (isNotFoundPathError(err)) throw new SafeOpenError("not-found", "file not found");
		throw err;
	}
}
async function resolvePathWithinRoot(params) {
	let rootReal;
	try {
		rootReal = await fs$1.realpath(params.rootDir);
	} catch (err) {
		if (isNotFoundPathError(err)) throw new SafeOpenError("not-found", "root dir not found");
		throw err;
	}
	const rootWithSep = ensureTrailingSep(rootReal);
	const expanded = await expandRelativePathWithHome(params.relativePath);
	const resolved = path.resolve(rootWithSep, expanded);
	if (!isPathInside(rootWithSep, resolved)) throw new SafeOpenError("outside-workspace", "file is outside workspace root");
	return {
		rootReal,
		rootWithSep,
		resolved
	};
}
async function openFileWithinRoot(params) {
	const { rootWithSep, resolved } = await resolvePathWithinRoot(params);
	let opened;
	try {
		opened = await openVerifiedLocalFile(resolved);
	} catch (err) {
		if (err instanceof SafeOpenError) {
			if (err.code === "not-found") throw err;
			throw new SafeOpenError("invalid-path", "path is not a regular file under root", { cause: err });
		}
		throw err;
	}
	if (params.rejectHardlinks !== false && opened.stat.nlink > 1) {
		await opened.handle.close().catch(() => {});
		throw new SafeOpenError("invalid-path", "hardlinked path not allowed");
	}
	if (!isPathInside(rootWithSep, opened.realPath)) {
		await opened.handle.close().catch(() => {});
		throw new SafeOpenError("outside-workspace", "file is outside workspace root");
	}
	return opened;
}
async function readFileWithinRoot(params) {
	const opened = await openFileWithinRoot({
		rootDir: params.rootDir,
		relativePath: params.relativePath,
		rejectHardlinks: params.rejectHardlinks
	});
	try {
		return await readOpenedFileSafely({
			opened,
			maxBytes: params.maxBytes
		});
	} finally {
		await opened.handle.close().catch(() => {});
	}
}
async function readPathWithinRoot(params) {
	const rootDir = path.resolve(params.rootDir);
	const candidatePath = path.isAbsolute(params.filePath) ? path.resolve(params.filePath) : path.resolve(rootDir, params.filePath);
	return await readFileWithinRoot({
		rootDir,
		relativePath: path.relative(rootDir, candidatePath),
		rejectHardlinks: params.rejectHardlinks,
		maxBytes: params.maxBytes
	});
}
function createRootScopedReadFile(params) {
	const rootDir = path.resolve(params.rootDir);
	return async (filePath) => {
		return (await readPathWithinRoot({
			rootDir,
			filePath,
			rejectHardlinks: params.rejectHardlinks,
			maxBytes: params.maxBytes
		})).buffer;
	};
}
async function readLocalFileSafely(params) {
	const opened = await openVerifiedLocalFile(params.filePath);
	try {
		return await readOpenedFileSafely({
			opened,
			maxBytes: params.maxBytes
		});
	} finally {
		await opened.handle.close().catch(() => {});
	}
}
async function readOpenedFileSafely(params) {
	if (params.maxBytes !== void 0 && params.opened.stat.size > params.maxBytes) throw new SafeOpenError("too-large", `file exceeds limit of ${params.maxBytes} bytes (got ${params.opened.stat.size})`);
	return {
		buffer: await params.opened.handle.readFile(),
		realPath: params.opened.realPath,
		stat: params.opened.stat
	};
}
function emitWriteBoundaryWarning(reason) {
	logWarn(`security: fs-safe write boundary warning (${reason})`);
}
function buildAtomicWriteTempPath(targetPath) {
	const dir = path.dirname(targetPath);
	const base = path.basename(targetPath);
	return path.join(dir, `.${base}.${process.pid}.${randomUUID()}.tmp`);
}
async function writeTempFileForAtomicReplace(params) {
	const tempHandle = await fs$1.open(params.tempPath, OPEN_WRITE_CREATE_FLAGS, params.mode);
	try {
		if (typeof params.data === "string") await tempHandle.writeFile(params.data, params.encoding ?? "utf8");
		else await tempHandle.writeFile(params.data);
		return await tempHandle.stat();
	} finally {
		await tempHandle.close().catch(() => {});
	}
}
async function verifyAtomicWriteResult(params) {
	const rootWithSep = ensureTrailingSep(await fs$1.realpath(params.rootDir));
	const opened = await openVerifiedLocalFile(params.targetPath, { rejectHardlinks: true });
	try {
		if (!sameFileIdentity$1(opened.stat, params.expectedIdentity)) throw new SafeOpenError("path-mismatch", "path changed during write");
		if (!isPathInside(rootWithSep, opened.realPath)) throw new SafeOpenError("outside-workspace", "file is outside workspace root");
	} finally {
		await opened.handle.close().catch(() => {});
	}
}
async function resolveOpenedFileRealPathForHandle(handle, ioPath) {
	try {
		return await fs$1.realpath(ioPath);
	} catch (err) {
		if (!isNotFoundPathError(err)) throw err;
	}
	const fdCandidates = process.platform === "linux" ? [`/proc/self/fd/${handle.fd}`, `/dev/fd/${handle.fd}`] : process.platform === "win32" ? [] : [`/dev/fd/${handle.fd}`];
	for (const fdPath of fdCandidates) try {
		return await fs$1.realpath(fdPath);
	} catch {}
	throw new SafeOpenError("path-mismatch", "unable to resolve opened file path");
}
async function openWritableFileWithinRoot(params) {
	const { rootReal, rootWithSep, resolved } = await resolvePathWithinRoot(params);
	try {
		await assertNoPathAliasEscape({
			absolutePath: resolved,
			rootPath: rootReal,
			boundaryLabel: "root"
		});
	} catch (err) {
		throw new SafeOpenError("invalid-path", "path alias escape blocked", { cause: err });
	}
	if (params.mkdir !== false) await fs$1.mkdir(path.dirname(resolved), { recursive: true });
	let ioPath = resolved;
	try {
		const resolvedRealPath = await fs$1.realpath(resolved);
		if (!isPathInside(rootWithSep, resolvedRealPath)) throw new SafeOpenError("outside-workspace", "file is outside workspace root");
		ioPath = resolvedRealPath;
	} catch (err) {
		if (err instanceof SafeOpenError) throw err;
		if (!isNotFoundPathError(err)) throw err;
	}
	const fileMode = params.mode ?? 384;
	let handle;
	let createdForWrite = false;
	const existingFlags = params.append ? OPEN_APPEND_EXISTING_FLAGS : OPEN_WRITE_EXISTING_FLAGS;
	const createFlags = params.append ? OPEN_APPEND_CREATE_FLAGS : OPEN_WRITE_CREATE_FLAGS;
	try {
		try {
			handle = await fs$1.open(ioPath, existingFlags, fileMode);
		} catch (err) {
			if (!isNotFoundPathError(err)) throw err;
			handle = await fs$1.open(ioPath, createFlags, fileMode);
			createdForWrite = true;
		}
	} catch (err) {
		if (isNotFoundPathError(err)) throw new SafeOpenError("not-found", "file not found");
		if (isSymlinkOpenError(err)) throw new SafeOpenError("invalid-path", "symlink open blocked", { cause: err });
		throw err;
	}
	let openedRealPath = null;
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) throw new SafeOpenError("invalid-path", "path is not a regular file under root");
		if (stat.nlink > 1) throw new SafeOpenError("invalid-path", "hardlinked path not allowed");
		try {
			const lstat = await fs$1.lstat(ioPath);
			if (lstat.isSymbolicLink() || !lstat.isFile()) throw new SafeOpenError("invalid-path", "path is not a regular file under root");
			if (!sameFileIdentity$1(stat, lstat)) throw new SafeOpenError("path-mismatch", "path changed during write");
		} catch (err) {
			if (!isNotFoundPathError(err)) throw err;
		}
		const realPath = await resolveOpenedFileRealPathForHandle(handle, ioPath);
		openedRealPath = realPath;
		const realStat = await fs$1.stat(realPath);
		if (!sameFileIdentity$1(stat, realStat)) throw new SafeOpenError("path-mismatch", "path mismatch");
		if (realStat.nlink > 1) throw new SafeOpenError("invalid-path", "hardlinked path not allowed");
		if (!isPathInside(rootWithSep, realPath)) throw new SafeOpenError("outside-workspace", "file is outside workspace root");
		if (params.append !== true && params.truncateExisting !== false && !createdForWrite) await handle.truncate(0);
		return {
			handle,
			createdForWrite,
			openedRealPath: realPath,
			openedStat: stat
		};
	} catch (err) {
		const cleanupCreatedPath = createdForWrite && err instanceof SafeOpenError;
		const cleanupPath = openedRealPath ?? ioPath;
		await handle.close().catch(() => {});
		if (cleanupCreatedPath) await fs$1.rm(cleanupPath, { force: true }).catch(() => {});
		throw err;
	}
}
async function appendFileWithinRoot(params) {
	const target = await openWritableFileWithinRoot({
		rootDir: params.rootDir,
		relativePath: params.relativePath,
		mkdir: params.mkdir,
		truncateExisting: false,
		append: true
	});
	try {
		let prefix = "";
		if (params.prependNewlineIfNeeded === true && !target.createdForWrite && target.openedStat.size > 0 && (typeof params.data === "string" && !params.data.startsWith("\n") || Buffer.isBuffer(params.data) && params.data.length > 0 && params.data[0] !== 10)) {
			const lastByte = Buffer.alloc(1);
			const { bytesRead } = await target.handle.read(lastByte, 0, 1, target.openedStat.size - 1);
			if (bytesRead === 1 && lastByte[0] !== 10) prefix = "\n";
		}
		if (typeof params.data === "string") {
			await target.handle.appendFile(`${prefix}${params.data}`, params.encoding ?? "utf8");
			return;
		}
		const payload = prefix.length > 0 ? Buffer.concat([Buffer.from(prefix, "utf8"), params.data]) : params.data;
		await target.handle.appendFile(payload);
	} finally {
		await target.handle.close().catch(() => {});
	}
}
async function writeFileWithinRoot(params) {
	if (process.platform === "win32") {
		await writeFileWithinRootLegacy(params);
		return;
	}
	const pinned = await resolvePinnedWriteTargetWithinRoot({
		rootDir: params.rootDir,
		relativePath: params.relativePath
	});
	const identity = await runPinnedWriteHelper({
		rootPath: pinned.rootReal,
		relativeParentPath: pinned.relativeParentPath,
		basename: pinned.basename,
		mkdir: params.mkdir !== false,
		mode: pinned.mode,
		input: {
			kind: "buffer",
			data: params.data,
			encoding: params.encoding
		}
	}).catch((error) => {
		throw normalizePinnedWriteError(error);
	});
	try {
		await verifyAtomicWriteResult({
			rootDir: params.rootDir,
			targetPath: pinned.targetPath,
			expectedIdentity: identity
		});
	} catch (err) {
		emitWriteBoundaryWarning(`post-write verification failed: ${String(err)}`);
		throw err;
	}
}
async function copyFileWithinRoot(params) {
	const source = await openVerifiedLocalFile(params.sourcePath, { rejectHardlinks: params.rejectSourceHardlinks });
	if (params.maxBytes !== void 0 && source.stat.size > params.maxBytes) {
		await source.handle.close().catch(() => {});
		throw new SafeOpenError("too-large", `file exceeds limit of ${params.maxBytes} bytes (got ${source.stat.size})`);
	}
	try {
		if (process.platform === "win32") {
			await copyFileWithinRootLegacy(params, source);
			return;
		}
		const pinned = await resolvePinnedWriteTargetWithinRoot({
			rootDir: params.rootDir,
			relativePath: params.relativePath
		});
		const sourceStream = source.handle.createReadStream();
		const identity = await runPinnedWriteHelper({
			rootPath: pinned.rootReal,
			relativeParentPath: pinned.relativeParentPath,
			basename: pinned.basename,
			mkdir: params.mkdir !== false,
			mode: pinned.mode,
			input: {
				kind: "stream",
				stream: sourceStream
			}
		}).catch((error) => {
			throw normalizePinnedWriteError(error);
		});
		try {
			await verifyAtomicWriteResult({
				rootDir: params.rootDir,
				targetPath: pinned.targetPath,
				expectedIdentity: identity
			});
		} catch (err) {
			emitWriteBoundaryWarning(`post-copy verification failed: ${String(err)}`);
			throw err;
		}
	} finally {
		await source.handle.close().catch(() => {});
	}
}
async function writeFileFromPathWithinRoot(params) {
	await copyFileWithinRoot({
		sourcePath: params.sourcePath,
		rootDir: params.rootDir,
		relativePath: params.relativePath,
		mkdir: params.mkdir,
		rejectSourceHardlinks: true
	});
}
async function resolvePinnedWriteTargetWithinRoot(params) {
	const { rootReal, rootWithSep, resolved } = await resolvePathWithinRoot(params);
	try {
		await assertNoPathAliasEscape({
			absolutePath: resolved,
			rootPath: rootReal,
			boundaryLabel: "root"
		});
	} catch (err) {
		throw new SafeOpenError("invalid-path", "path alias escape blocked", { cause: err });
	}
	const relativeResolved = path.relative(rootReal, resolved);
	if (relativeResolved.startsWith("..") || path.isAbsolute(relativeResolved)) throw new SafeOpenError("outside-workspace", "file is outside workspace root");
	const relativePosix = relativeResolved ? relativeResolved.split(path.sep).join(path.posix.sep) : "";
	const basename = path.posix.basename(relativePosix);
	if (!basename || basename === "." || basename === "/") throw new SafeOpenError("invalid-path", "invalid target path");
	let mode = 384;
	try {
		const opened = await openFileWithinRoot({
			rootDir: params.rootDir,
			relativePath: params.relativePath,
			rejectHardlinks: true
		});
		try {
			mode = opened.stat.mode & 511;
			if (!isPathInside(rootWithSep, opened.realPath)) throw new SafeOpenError("outside-workspace", "file is outside workspace root");
		} finally {
			await opened.handle.close().catch(() => {});
		}
	} catch (err) {
		if (!(err instanceof SafeOpenError) || err.code !== "not-found") throw err;
	}
	return {
		rootReal,
		targetPath: resolved,
		relativeParentPath: path.posix.dirname(relativePosix) === "." ? "" : path.posix.dirname(relativePosix),
		basename,
		mode: mode || 384
	};
}
function normalizePinnedWriteError(error) {
	if (error instanceof SafeOpenError) return error;
	return new SafeOpenError("invalid-path", "path is not a regular file under root", { cause: error instanceof Error ? error : void 0 });
}
async function writeFileWithinRootLegacy(params) {
	const target = await openWritableFileWithinRoot({
		rootDir: params.rootDir,
		relativePath: params.relativePath,
		mkdir: params.mkdir,
		truncateExisting: false
	});
	const destinationPath = target.openedRealPath;
	const targetMode = target.openedStat.mode & 511;
	await target.handle.close().catch(() => {});
	let tempPath = null;
	try {
		tempPath = buildAtomicWriteTempPath(destinationPath);
		const writtenStat = await writeTempFileForAtomicReplace({
			tempPath,
			data: params.data,
			encoding: params.encoding,
			mode: targetMode || 384
		});
		await fs$1.rename(tempPath, destinationPath);
		tempPath = null;
		try {
			await verifyAtomicWriteResult({
				rootDir: params.rootDir,
				targetPath: destinationPath,
				expectedIdentity: writtenStat
			});
		} catch (err) {
			emitWriteBoundaryWarning(`post-write verification failed: ${String(err)}`);
			throw err;
		}
	} finally {
		if (tempPath) await fs$1.rm(tempPath, { force: true }).catch(() => {});
	}
}
async function copyFileWithinRootLegacy(params, source) {
	let target = null;
	let sourceClosedByStream = false;
	let targetClosedByUs = false;
	let tempHandle = null;
	let tempPath = null;
	let tempClosedByStream = false;
	try {
		target = await openWritableFileWithinRoot({
			rootDir: params.rootDir,
			relativePath: params.relativePath,
			mkdir: params.mkdir,
			truncateExisting: false
		});
		const destinationPath = target.openedRealPath;
		const targetMode = target.openedStat.mode & 511;
		await target.handle.close().catch(() => {});
		targetClosedByUs = true;
		tempPath = buildAtomicWriteTempPath(destinationPath);
		tempHandle = await fs$1.open(tempPath, OPEN_WRITE_CREATE_FLAGS, targetMode || 384);
		const sourceStream = source.handle.createReadStream();
		const targetStream = tempHandle.createWriteStream();
		sourceStream.once("close", () => {
			sourceClosedByStream = true;
		});
		targetStream.once("close", () => {
			tempClosedByStream = true;
		});
		await import("node:stream/promises").then(({ pipeline }) => pipeline(sourceStream, targetStream));
		const writtenStat = await fs$1.stat(tempPath);
		if (!tempClosedByStream) {
			await tempHandle.close().catch(() => {});
			tempClosedByStream = true;
		}
		tempHandle = null;
		await fs$1.rename(tempPath, destinationPath);
		tempPath = null;
		try {
			await verifyAtomicWriteResult({
				rootDir: params.rootDir,
				targetPath: destinationPath,
				expectedIdentity: writtenStat
			});
		} catch (err) {
			emitWriteBoundaryWarning(`post-copy verification failed: ${String(err)}`);
			throw err;
		}
	} catch (err) {
		if (target?.createdForWrite) await fs$1.rm(target.openedRealPath, { force: true }).catch(() => {});
		throw err;
	} finally {
		if (tempPath) await fs$1.rm(tempPath, { force: true }).catch(() => {});
		if (!sourceClosedByStream) await source.handle.close().catch(() => {});
		if (tempHandle && !tempClosedByStream) await tempHandle.close().catch(() => {});
		if (target && !targetClosedByUs) await target.handle.close().catch(() => {});
	}
}
//#endregion
//#region src/media/constants.ts
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
const MAX_VIDEO_BYTES = 16 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024;
function mediaKindFromMime(mime) {
	if (!mime) return;
	if (mime.startsWith("image/")) return "image";
	if (mime.startsWith("audio/")) return "audio";
	if (mime.startsWith("video/")) return "video";
	if (mime === "application/pdf") return "document";
	if (mime.startsWith("text/")) return "document";
	if (mime.startsWith("application/")) return "document";
}
function maxBytesForKind(kind) {
	switch (kind) {
		case "image": return MAX_IMAGE_BYTES;
		case "audio": return MAX_AUDIO_BYTES;
		case "video": return MAX_VIDEO_BYTES;
		case "document": return MAX_DOCUMENT_BYTES;
		default: return MAX_DOCUMENT_BYTES;
	}
}
//#endregion
//#region src/media/mime.ts
const EXT_BY_MIME = {
	"image/heic": ".heic",
	"image/heif": ".heif",
	"image/jpeg": ".jpg",
	"image/png": ".png",
	"image/webp": ".webp",
	"image/gif": ".gif",
	"audio/ogg": ".ogg",
	"audio/mpeg": ".mp3",
	"audio/wav": ".wav",
	"audio/flac": ".flac",
	"audio/aac": ".aac",
	"audio/opus": ".opus",
	"audio/x-m4a": ".m4a",
	"audio/mp4": ".m4a",
	"video/mp4": ".mp4",
	"video/quicktime": ".mov",
	"application/pdf": ".pdf",
	"application/json": ".json",
	"application/zip": ".zip",
	"application/gzip": ".gz",
	"application/x-tar": ".tar",
	"application/x-7z-compressed": ".7z",
	"application/vnd.rar": ".rar",
	"application/msword": ".doc",
	"application/vnd.ms-excel": ".xls",
	"application/vnd.ms-powerpoint": ".ppt",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
	"text/csv": ".csv",
	"text/plain": ".txt",
	"text/markdown": ".md"
};
const MIME_BY_EXT = {
	...Object.fromEntries(Object.entries(EXT_BY_MIME).map(([mime, ext]) => [ext, mime])),
	".jpeg": "image/jpeg",
	".js": "text/javascript"
};
const AUDIO_FILE_EXTENSIONS = new Set([
	".aac",
	".caf",
	".flac",
	".m4a",
	".mp3",
	".oga",
	".ogg",
	".opus",
	".wav"
]);
function normalizeMimeType(mime) {
	if (!mime) return;
	return mime.split(";")[0]?.trim().toLowerCase() || void 0;
}
async function sniffMime(buffer) {
	if (!buffer) return;
	try {
		return (await fileTypeFromBuffer(buffer))?.mime ?? void 0;
	} catch {
		return;
	}
}
function getFileExtension(filePath) {
	if (!filePath) return;
	try {
		if (/^https?:\/\//i.test(filePath)) {
			const url = new URL(filePath);
			return path.extname(url.pathname).toLowerCase() || void 0;
		}
	} catch {}
	return path.extname(filePath).toLowerCase() || void 0;
}
function isAudioFileName(fileName) {
	const ext = getFileExtension(fileName);
	if (!ext) return false;
	return AUDIO_FILE_EXTENSIONS.has(ext);
}
function detectMime(opts) {
	return detectMimeImpl(opts);
}
function isGenericMime(mime) {
	if (!mime) return true;
	const m = mime.toLowerCase();
	return m === "application/octet-stream" || m === "application/zip";
}
async function detectMimeImpl(opts) {
	const ext = getFileExtension(opts.filePath);
	const extMime = ext ? MIME_BY_EXT[ext] : void 0;
	const headerMime = normalizeMimeType(opts.headerMime);
	const sniffed = await sniffMime(opts.buffer);
	if (sniffed && (!isGenericMime(sniffed) || !extMime)) return sniffed;
	if (extMime) return extMime;
	if (headerMime && !isGenericMime(headerMime)) return headerMime;
	if (sniffed) return sniffed;
	if (headerMime) return headerMime;
}
function extensionForMime(mime) {
	const normalized = normalizeMimeType(mime);
	if (!normalized) return;
	return EXT_BY_MIME[normalized];
}
function isGifMedia(opts) {
	if (opts.contentType?.toLowerCase() === "image/gif") return true;
	return getFileExtension(opts.fileName) === ".gif";
}
function imageMimeFromFormat(format) {
	if (!format) return;
	switch (format.toLowerCase()) {
		case "jpg":
		case "jpeg": return "image/jpeg";
		case "heic": return "image/heic";
		case "heif": return "image/heif";
		case "png": return "image/png";
		case "webp": return "image/webp";
		case "gif": return "image/gif";
		default: return;
	}
}
function kindFromMime(mime) {
	return mediaKindFromMime(normalizeMimeType(mime));
}
//#endregion
//#region src/plugin-sdk/windows-spawn.ts
function isFilePath(candidate) {
	try {
		return statSync(candidate).isFile();
	} catch {
		return false;
	}
}
function resolveWindowsExecutablePath(command, env) {
	if (command.includes("/") || command.includes("\\") || path.isAbsolute(command)) return command;
	const pathEntries = (env.PATH ?? env.Path ?? process.env.PATH ?? process.env.Path ?? "").split(";").map((entry) => entry.trim()).filter(Boolean);
	const hasExtension = path.extname(command).length > 0;
	const pathExtRaw = env.PATHEXT ?? env.Pathext ?? process.env.PATHEXT ?? process.env.Pathext ?? ".EXE;.CMD;.BAT;.COM";
	const pathExt = hasExtension ? [""] : pathExtRaw.split(";").map((ext) => ext.trim()).filter(Boolean).map((ext) => ext.startsWith(".") ? ext : `.${ext}`);
	for (const dir of pathEntries) for (const ext of pathExt) for (const candidateExt of [
		ext,
		ext.toLowerCase(),
		ext.toUpperCase()
	]) {
		const candidate = path.join(dir, `${command}${candidateExt}`);
		if (isFilePath(candidate)) return candidate;
	}
	return command;
}
function resolveEntrypointFromCmdShim(wrapperPath) {
	if (!isFilePath(wrapperPath)) return null;
	try {
		const content = readFileSync(wrapperPath, "utf8");
		const candidates = [];
		for (const match of content.matchAll(/"([^"\r\n]*)"/g)) {
			const relative = (match[1] ?? "").match(/%~?dp0%?\s*[\\/]*(.*)$/i)?.[1]?.trim();
			if (!relative) continue;
			const normalizedRelative = relative.replace(/[\\/]+/g, path.sep).replace(/^[\\/]+/, "");
			const candidate = path.resolve(path.dirname(wrapperPath), normalizedRelative);
			if (isFilePath(candidate)) candidates.push(candidate);
		}
		return candidates.find((candidate) => {
			const base = path.basename(candidate).toLowerCase();
			return base !== "node.exe" && base !== "node";
		}) ?? null;
	} catch {
		return null;
	}
}
function resolveBinEntry(packageName, binField) {
	if (typeof binField === "string") return binField.trim() || null;
	if (!binField || typeof binField !== "object") return null;
	if (packageName) {
		const preferred = binField[packageName];
		if (typeof preferred === "string" && preferred.trim()) return preferred.trim();
	}
	for (const value of Object.values(binField)) if (typeof value === "string" && value.trim()) return value.trim();
	return null;
}
function resolveEntrypointFromPackageJson(wrapperPath, packageName) {
	if (!packageName) return null;
	const wrapperDir = path.dirname(wrapperPath);
	const packageDirs = [path.resolve(wrapperDir, "..", packageName), path.resolve(wrapperDir, "node_modules", packageName)];
	for (const packageDir of packageDirs) {
		const packageJsonPath = path.join(packageDir, "package.json");
		if (!isFilePath(packageJsonPath)) continue;
		try {
			const entryRel = resolveBinEntry(packageName, JSON.parse(readFileSync(packageJsonPath, "utf8")).bin);
			if (!entryRel) continue;
			const entryPath = path.resolve(packageDir, entryRel);
			if (isFilePath(entryPath)) return entryPath;
		} catch {}
	}
	return null;
}
function resolveWindowsSpawnProgramCandidate(params) {
	const platform = params.platform ?? process.platform;
	const env = params.env ?? process.env;
	const execPath = params.execPath ?? process.execPath;
	if (platform !== "win32") return {
		command: params.command,
		leadingArgv: [],
		resolution: "direct"
	};
	const resolvedCommand = resolveWindowsExecutablePath(params.command, env);
	const ext = path.extname(resolvedCommand).toLowerCase();
	if (ext === ".js" || ext === ".cjs" || ext === ".mjs") return {
		command: execPath,
		leadingArgv: [resolvedCommand],
		resolution: "node-entrypoint",
		windowsHide: true
	};
	if (ext === ".cmd" || ext === ".bat") {
		const entrypoint = resolveEntrypointFromCmdShim(resolvedCommand) ?? resolveEntrypointFromPackageJson(resolvedCommand, params.packageName);
		if (entrypoint) {
			if (path.extname(entrypoint).toLowerCase() === ".exe") return {
				command: entrypoint,
				leadingArgv: [],
				resolution: "exe-entrypoint",
				windowsHide: true
			};
			return {
				command: execPath,
				leadingArgv: [entrypoint],
				resolution: "node-entrypoint",
				windowsHide: true
			};
		}
		return {
			command: resolvedCommand,
			leadingArgv: [],
			resolution: "unresolved-wrapper"
		};
	}
	return {
		command: resolvedCommand,
		leadingArgv: [],
		resolution: "direct"
	};
}
function applyWindowsSpawnProgramPolicy(params) {
	if (params.candidate.resolution !== "unresolved-wrapper") return {
		command: params.candidate.command,
		leadingArgv: params.candidate.leadingArgv,
		resolution: params.candidate.resolution,
		windowsHide: params.candidate.windowsHide
	};
	if (params.allowShellFallback !== false) return {
		command: params.candidate.command,
		leadingArgv: [],
		resolution: "shell-fallback",
		shell: true
	};
	throw new Error(`${path.basename(params.candidate.command)} wrapper resolved, but no executable/Node entrypoint could be resolved without shell execution.`);
}
function resolveWindowsSpawnProgram(params) {
	return applyWindowsSpawnProgramPolicy({
		candidate: resolveWindowsSpawnProgramCandidate(params),
		allowShellFallback: params.allowShellFallback
	});
}
function materializeWindowsSpawnProgram(program, argv) {
	return {
		command: program.command,
		argv: [...program.leadingArgv, ...argv],
		resolution: program.resolution,
		shell: program.shell,
		windowsHide: program.windowsHide
	};
}
//#endregion
//#region src/config/sessions/paths.ts
function resolveAgentSessionsDir(agentId, env = process.env, homedir = () => resolveRequiredHomeDir(env, os.homedir)) {
	const root = resolveStateDir(env, homedir);
	const id = normalizeAgentId(agentId ?? "main");
	return path.join(root, "agents", id, "sessions");
}
function resolveSessionTranscriptsDirForAgent(agentId, env = process.env, homedir = () => resolveRequiredHomeDir(env, os.homedir)) {
	return resolveAgentSessionsDir(agentId, env, homedir);
}
function resolveDefaultSessionStorePath(agentId) {
	return path.join(resolveAgentSessionsDir(agentId), "sessions.json");
}
const MULTI_STORE_PATH_SENTINEL = "(multiple)";
function resolveSessionFilePathOptions(params) {
	const agentId = params.agentId?.trim();
	const storePath = params.storePath?.trim();
	if (storePath && storePath !== MULTI_STORE_PATH_SENTINEL) {
		const sessionsDir = path.dirname(path.resolve(storePath));
		return agentId ? {
			sessionsDir,
			agentId
		} : { sessionsDir };
	}
	if (agentId) return { agentId };
}
const SAFE_SESSION_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
function validateSessionId(sessionId) {
	const trimmed = sessionId.trim();
	if (!SAFE_SESSION_ID_RE.test(trimmed)) throw new Error(`Invalid session ID: ${sessionId}`);
	return trimmed;
}
function resolveSessionsDir(opts) {
	const sessionsDir = opts?.sessionsDir?.trim();
	if (sessionsDir) return path.resolve(sessionsDir);
	return resolveAgentSessionsDir(opts?.agentId);
}
function resolvePathFromAgentSessionsDir(agentSessionsDir, candidateAbsPath) {
	const agentBase = safeRealpathSync(path.resolve(agentSessionsDir)) ?? path.resolve(agentSessionsDir);
	const realCandidate = safeRealpathSync(candidateAbsPath) ?? candidateAbsPath;
	const relative = path.relative(agentBase, realCandidate);
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return;
	return path.resolve(agentBase, relative);
}
function resolveSiblingAgentSessionsDir(baseSessionsDir, agentId) {
	const resolvedBase = path.resolve(baseSessionsDir);
	if (path.basename(resolvedBase) !== "sessions") return;
	const baseAgentDir = path.dirname(resolvedBase);
	const baseAgentsDir = path.dirname(baseAgentDir);
	if (path.basename(baseAgentsDir) !== "agents") return;
	const rootDir = path.dirname(baseAgentsDir);
	return path.join(rootDir, "agents", normalizeAgentId(agentId), "sessions");
}
function resolveAgentSessionsPathParts(candidateAbsPath) {
	const parts = path.normalize(path.resolve(candidateAbsPath)).split(path.sep).filter(Boolean);
	const sessionsIndex = parts.lastIndexOf("sessions");
	if (sessionsIndex < 2 || parts[sessionsIndex - 2] !== "agents") return null;
	return {
		parts,
		sessionsIndex
	};
}
function extractAgentIdFromAbsoluteSessionPath(candidateAbsPath) {
	const parsed = resolveAgentSessionsPathParts(candidateAbsPath);
	if (!parsed) return;
	const { parts, sessionsIndex } = parsed;
	return parts[sessionsIndex - 1] || void 0;
}
function resolveStructuralSessionFallbackPath(candidateAbsPath, expectedAgentId) {
	const parsed = resolveAgentSessionsPathParts(candidateAbsPath);
	if (!parsed) return;
	const { parts, sessionsIndex } = parsed;
	const agentIdPart = parts[sessionsIndex - 1];
	if (!agentIdPart) return;
	const normalizedAgentId = normalizeAgentId(agentIdPart);
	if (normalizedAgentId !== agentIdPart.toLowerCase()) return;
	if (normalizedAgentId !== normalizeAgentId(expectedAgentId)) return;
	const relativeSegments = parts.slice(sessionsIndex + 1);
	if (relativeSegments.length !== 1) return;
	const fileName = relativeSegments[0];
	if (!fileName || fileName === "." || fileName === "..") return;
	return path.normalize(path.resolve(candidateAbsPath));
}
function safeRealpathSync(filePath) {
	try {
		return fs.realpathSync(filePath);
	} catch {
		return;
	}
}
function resolvePathWithinSessionsDir(sessionsDir, candidate, opts) {
	const trimmed = candidate.trim();
	if (!trimmed) throw new Error("Session file path must not be empty");
	const resolvedBase = path.resolve(sessionsDir);
	const realBase = safeRealpathSync(resolvedBase) ?? resolvedBase;
	const realTrimmed = path.isAbsolute(trimmed) ? safeRealpathSync(trimmed) ?? trimmed : trimmed;
	const normalized = path.isAbsolute(realTrimmed) ? path.relative(realBase, realTrimmed) : realTrimmed;
	if (normalized.startsWith("..") && path.isAbsolute(realTrimmed)) {
		const tryAgentFallback = (agentId) => {
			const normalizedAgentId = normalizeAgentId(agentId);
			const siblingSessionsDir = resolveSiblingAgentSessionsDir(realBase, normalizedAgentId);
			if (siblingSessionsDir) {
				const siblingResolved = resolvePathFromAgentSessionsDir(siblingSessionsDir, realTrimmed);
				if (siblingResolved) return siblingResolved;
			}
			return resolvePathFromAgentSessionsDir(resolveAgentSessionsDir(normalizedAgentId), realTrimmed);
		};
		const explicitAgentId = opts?.agentId?.trim();
		if (explicitAgentId) {
			const resolvedFromAgent = tryAgentFallback(explicitAgentId);
			if (resolvedFromAgent) return resolvedFromAgent;
		}
		const extractedAgentId = extractAgentIdFromAbsoluteSessionPath(realTrimmed);
		if (extractedAgentId) {
			const resolvedFromPath = tryAgentFallback(extractedAgentId);
			if (resolvedFromPath) return resolvedFromPath;
			const structuralFallback = resolveStructuralSessionFallbackPath(realTrimmed, extractedAgentId);
			if (structuralFallback) return structuralFallback;
		}
	}
	if (!normalized || normalized.startsWith("..") || path.isAbsolute(normalized)) throw new Error("Session file path must be within sessions directory");
	return path.resolve(realBase, normalized);
}
function resolveSessionTranscriptPathInDir(sessionId, sessionsDir, topicId) {
	const safeSessionId = validateSessionId(sessionId);
	const safeTopicId = typeof topicId === "string" ? encodeURIComponent(topicId) : typeof topicId === "number" ? String(topicId) : void 0;
	return resolvePathWithinSessionsDir(sessionsDir, safeTopicId !== void 0 ? `${safeSessionId}-topic-${safeTopicId}.jsonl` : `${safeSessionId}.jsonl`);
}
function resolveSessionTranscriptPath(sessionId, agentId, topicId) {
	return resolveSessionTranscriptPathInDir(sessionId, resolveAgentSessionsDir(agentId), topicId);
}
function resolveSessionFilePath(sessionId, entry, opts) {
	const sessionsDir = resolveSessionsDir(opts);
	const candidate = entry?.sessionFile?.trim();
	if (candidate) try {
		return resolvePathWithinSessionsDir(sessionsDir, candidate, { agentId: opts?.agentId });
	} catch {}
	return resolveSessionTranscriptPathInDir(sessionId, sessionsDir);
}
function resolveStorePath(store, opts) {
	const agentId = normalizeAgentId(opts?.agentId ?? "main");
	const env = opts?.env ?? process.env;
	const homedir = () => resolveRequiredHomeDir(env, os.homedir);
	if (!store) return path.join(resolveAgentSessionsDir(agentId, env, homedir), "sessions.json");
	if (store.includes("{agentId}")) {
		const expanded = store.replaceAll("{agentId}", agentId);
		if (expanded.startsWith("~")) return path.resolve(expandHomePrefix(expanded, {
			home: resolveRequiredHomeDir(env, homedir),
			env,
			homedir
		}));
		return path.resolve(expanded);
	}
	if (store.startsWith("~")) return path.resolve(expandHomePrefix(store, {
		home: resolveRequiredHomeDir(env, homedir),
		env,
		homedir
	}));
	return path.resolve(store);
}
function resolveAgentsDirFromSessionStorePath(storePath) {
	const candidateAbsPath = path.resolve(storePath);
	if (path.basename(candidateAbsPath) !== "sessions.json") return;
	const sessionsDir = path.dirname(candidateAbsPath);
	if (path.basename(sessionsDir) !== "sessions") return;
	const agentDir = path.dirname(sessionsDir);
	const agentsDir = path.dirname(agentDir);
	if (path.basename(agentsDir) !== "agents") return;
	return agentsDir;
}
//#endregion
//#region src/memory/multimodal.ts
const MEMORY_MULTIMODAL_SPECS = {
	image: {
		labelPrefix: "Image file",
		extensions: [
			".jpg",
			".jpeg",
			".png",
			".webp",
			".gif",
			".heic",
			".heif"
		]
	},
	audio: {
		labelPrefix: "Audio file",
		extensions: [
			".mp3",
			".wav",
			".ogg",
			".opus",
			".m4a",
			".aac",
			".flac"
		]
	}
};
const MEMORY_MULTIMODAL_MODALITIES = Object.keys(MEMORY_MULTIMODAL_SPECS);
const DEFAULT_MEMORY_MULTIMODAL_MAX_FILE_BYTES = 10 * 1024 * 1024;
function normalizeMemoryMultimodalModalities(raw) {
	if (raw === void 0 || raw.includes("all")) return [...MEMORY_MULTIMODAL_MODALITIES];
	const normalized = /* @__PURE__ */ new Set();
	for (const value of raw) if (value === "image" || value === "audio") normalized.add(value);
	return Array.from(normalized);
}
function normalizeMemoryMultimodalSettings(raw) {
	const enabled = raw.enabled === true;
	const maxFileBytes = typeof raw.maxFileBytes === "number" && Number.isFinite(raw.maxFileBytes) ? Math.max(1, Math.floor(raw.maxFileBytes)) : DEFAULT_MEMORY_MULTIMODAL_MAX_FILE_BYTES;
	return {
		enabled,
		modalities: enabled ? normalizeMemoryMultimodalModalities(raw.modalities) : [],
		maxFileBytes
	};
}
function isMemoryMultimodalEnabled(settings) {
	return settings.enabled && settings.modalities.length > 0;
}
function getMemoryMultimodalExtensions(modality) {
	return MEMORY_MULTIMODAL_SPECS[modality].extensions;
}
function buildMemoryMultimodalLabel(modality, normalizedPath) {
	return `${MEMORY_MULTIMODAL_SPECS[modality].labelPrefix}: ${normalizedPath}`;
}
function buildCaseInsensitiveExtensionGlob(extension) {
	const normalized = extension.trim().replace(/^\./, "").toLowerCase();
	if (!normalized) return "*";
	return `*.${Array.from(normalized, (char) => `[${char.toLowerCase()}${char.toUpperCase()}]`).join("")}`;
}
function classifyMemoryMultimodalPath(filePath, settings) {
	if (!isMemoryMultimodalEnabled(settings)) return null;
	const lower = filePath.trim().toLowerCase();
	for (const modality of settings.modalities) for (const extension of getMemoryMultimodalExtensions(modality)) if (lower.endsWith(extension)) return modality;
	return null;
}
function normalizeGeminiEmbeddingModelForMemory(model) {
	const trimmed = model.trim();
	if (!trimmed) return "";
	return trimmed.replace(/^models\//, "").replace(/^(gemini|google)\//, "");
}
function supportsMemoryMultimodalEmbeddings(params) {
	if (params.provider !== "gemini") return false;
	return normalizeGeminiEmbeddingModelForMemory(params.model) === "gemini-embedding-2-preview";
}
//#endregion
//#region src/memory/fs-utils.ts
function isFileMissingError(err) {
	return Boolean(err && typeof err === "object" && "code" in err && err.code === "ENOENT");
}
async function statRegularFile(absPath) {
	let stat;
	try {
		stat = await fs$1.lstat(absPath);
	} catch (err) {
		if (isFileMissingError(err)) return { missing: true };
		throw err;
	}
	if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("path required");
	return {
		missing: false,
		stat
	};
}
//#endregion
//#region src/memory/embedding-input-limits.ts
function estimateUtf8Bytes(text) {
	if (!text) return 0;
	return Buffer.byteLength(text, "utf8");
}
function estimateStructuredEmbeddingInputBytes(input) {
	if (!input.parts?.length) return estimateUtf8Bytes(input.text);
	let total = 0;
	for (const part of input.parts) {
		if (part.type === "text") {
			total += estimateUtf8Bytes(part.text);
			continue;
		}
		total += estimateUtf8Bytes(part.mimeType);
		total += estimateUtf8Bytes(part.data);
	}
	return total;
}
function splitTextToUtf8ByteLimit(text, maxUtf8Bytes) {
	if (maxUtf8Bytes <= 0) return [text];
	if (estimateUtf8Bytes(text) <= maxUtf8Bytes) return [text];
	const parts = [];
	let cursor = 0;
	while (cursor < text.length) {
		let low = cursor + 1;
		let high = Math.min(text.length, cursor + maxUtf8Bytes);
		let best = cursor;
		while (low <= high) {
			const mid = Math.floor((low + high) / 2);
			if (estimateUtf8Bytes(text.slice(cursor, mid)) <= maxUtf8Bytes) {
				best = mid;
				low = mid + 1;
			} else high = mid - 1;
		}
		if (best <= cursor) best = Math.min(text.length, cursor + 1);
		if (best < text.length && best > cursor && text.charCodeAt(best - 1) >= 55296 && text.charCodeAt(best - 1) <= 56319 && text.charCodeAt(best) >= 56320 && text.charCodeAt(best) <= 57343) best -= 1;
		const part = text.slice(cursor, best);
		if (!part) break;
		parts.push(part);
		cursor = best;
	}
	return parts;
}
//#endregion
//#region src/memory/embedding-inputs.ts
function buildTextEmbeddingInput(text) {
	return { text };
}
function isInlineDataEmbeddingInputPart(part) {
	return part.type === "inline-data";
}
function hasNonTextEmbeddingParts(input) {
	if (!input?.parts?.length) return false;
	return input.parts.some((part) => isInlineDataEmbeddingInputPart(part));
}
//#endregion
//#region src/memory/internal.ts
const DISABLED_MULTIMODAL_SETTINGS = {
	enabled: false,
	modalities: [],
	maxFileBytes: 0
};
function ensureDir(dir) {
	try {
		fs.mkdirSync(dir, { recursive: true });
	} catch {}
	return dir;
}
function normalizeRelPath(value) {
	return value.trim().replace(/^[./]+/, "").replace(/\\/g, "/");
}
function normalizeExtraMemoryPaths(workspaceDir, extraPaths) {
	if (!extraPaths?.length) return [];
	const resolved = extraPaths.map((value) => value.trim()).filter(Boolean).map((value) => path.isAbsolute(value) ? path.resolve(value) : path.resolve(workspaceDir, value));
	return Array.from(new Set(resolved));
}
function isMemoryPath(relPath) {
	const normalized = normalizeRelPath(relPath);
	if (!normalized) return false;
	if (normalized === "MEMORY.md" || normalized === "memory.md") return true;
	return normalized.startsWith("memory/");
}
function isAllowedMemoryFilePath(filePath, multimodal) {
	if (filePath.endsWith(".md")) return true;
	return classifyMemoryMultimodalPath(filePath, multimodal ?? DISABLED_MULTIMODAL_SETTINGS) !== null;
}
async function walkDir(dir, files, multimodal) {
	const entries = await fs$1.readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isSymbolicLink()) continue;
		if (entry.isDirectory()) {
			await walkDir(full, files, multimodal);
			continue;
		}
		if (!entry.isFile()) continue;
		if (!isAllowedMemoryFilePath(full, multimodal)) continue;
		files.push(full);
	}
}
async function listMemoryFiles(workspaceDir, extraPaths, multimodal) {
	const result = [];
	const memoryFile = path.join(workspaceDir, "MEMORY.md");
	const altMemoryFile = path.join(workspaceDir, "memory.md");
	const memoryDir = path.join(workspaceDir, "memory");
	const addMarkdownFile = async (absPath) => {
		try {
			const stat = await fs$1.lstat(absPath);
			if (stat.isSymbolicLink() || !stat.isFile()) return;
			if (!absPath.endsWith(".md")) return;
			result.push(absPath);
		} catch {}
	};
	await addMarkdownFile(memoryFile);
	await addMarkdownFile(altMemoryFile);
	try {
		const dirStat = await fs$1.lstat(memoryDir);
		if (!dirStat.isSymbolicLink() && dirStat.isDirectory()) await walkDir(memoryDir, result);
	} catch {}
	const normalizedExtraPaths = normalizeExtraMemoryPaths(workspaceDir, extraPaths);
	if (normalizedExtraPaths.length > 0) for (const inputPath of normalizedExtraPaths) try {
		const stat = await fs$1.lstat(inputPath);
		if (stat.isSymbolicLink()) continue;
		if (stat.isDirectory()) {
			await walkDir(inputPath, result, multimodal);
			continue;
		}
		if (stat.isFile() && isAllowedMemoryFilePath(inputPath, multimodal)) result.push(inputPath);
	} catch {}
	if (result.length <= 1) return result;
	const seen = /* @__PURE__ */ new Set();
	const deduped = [];
	for (const entry of result) {
		let key = entry;
		try {
			key = await fs$1.realpath(entry);
		} catch {}
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(entry);
	}
	return deduped;
}
function hashText(value) {
	return crypto.createHash("sha256").update(value).digest("hex");
}
async function buildFileEntry(absPath, workspaceDir, multimodal) {
	let stat;
	try {
		stat = await fs$1.stat(absPath);
	} catch (err) {
		if (isFileMissingError(err)) return null;
		throw err;
	}
	const normalizedPath = path.relative(workspaceDir, absPath).replace(/\\/g, "/");
	const multimodalSettings = multimodal ?? DISABLED_MULTIMODAL_SETTINGS;
	const modality = classifyMemoryMultimodalPath(absPath, multimodalSettings);
	if (modality) {
		if (stat.size > multimodalSettings.maxFileBytes) return null;
		let buffer;
		try {
			buffer = await fs$1.readFile(absPath);
		} catch (err) {
			if (isFileMissingError(err)) return null;
			throw err;
		}
		const mimeType = await detectMime({
			buffer: buffer.subarray(0, 512),
			filePath: absPath
		});
		if (!mimeType || !mimeType.startsWith(`${modality}/`)) return null;
		const contentText = buildMemoryMultimodalLabel(modality, normalizedPath);
		const dataHash = crypto.createHash("sha256").update(buffer).digest("hex");
		const chunkHash = hashText(JSON.stringify({
			path: normalizedPath,
			contentText,
			mimeType,
			dataHash
		}));
		return {
			path: normalizedPath,
			absPath,
			mtimeMs: stat.mtimeMs,
			size: stat.size,
			hash: chunkHash,
			dataHash,
			kind: "multimodal",
			contentText,
			modality,
			mimeType
		};
	}
	let content;
	try {
		content = await fs$1.readFile(absPath, "utf-8");
	} catch (err) {
		if (isFileMissingError(err)) return null;
		throw err;
	}
	const hash = hashText(content);
	return {
		path: normalizedPath,
		absPath,
		mtimeMs: stat.mtimeMs,
		size: stat.size,
		hash,
		kind: "markdown"
	};
}
async function loadMultimodalEmbeddingInput(entry) {
	if (entry.kind !== "multimodal" || !entry.contentText || !entry.mimeType) return null;
	let stat;
	try {
		stat = await fs$1.stat(entry.absPath);
	} catch (err) {
		if (isFileMissingError(err)) return null;
		throw err;
	}
	if (stat.size !== entry.size) return null;
	let buffer;
	try {
		buffer = await fs$1.readFile(entry.absPath);
	} catch (err) {
		if (isFileMissingError(err)) return null;
		throw err;
	}
	const dataHash = crypto.createHash("sha256").update(buffer).digest("hex");
	if (entry.dataHash && entry.dataHash !== dataHash) return null;
	return {
		text: entry.contentText,
		parts: [{
			type: "text",
			text: entry.contentText
		}, {
			type: "inline-data",
			mimeType: entry.mimeType,
			data: buffer.toString("base64")
		}]
	};
}
async function buildMultimodalChunkForIndexing(entry) {
	const embeddingInput = await loadMultimodalEmbeddingInput(entry);
	if (!embeddingInput) return null;
	return {
		chunk: {
			startLine: 1,
			endLine: 1,
			text: entry.contentText ?? embeddingInput.text,
			hash: entry.hash,
			embeddingInput
		},
		structuredInputBytes: estimateStructuredEmbeddingInputBytes(embeddingInput)
	};
}
function chunkMarkdown(content, chunking) {
	const lines = content.split("\n");
	if (lines.length === 0) return [];
	const maxChars = Math.max(32, chunking.tokens * 4);
	const overlapChars = Math.max(0, chunking.overlap * 4);
	const chunks = [];
	let current = [];
	let currentChars = 0;
	const flush = () => {
		if (current.length === 0) return;
		const firstEntry = current[0];
		const lastEntry = current[current.length - 1];
		if (!firstEntry || !lastEntry) return;
		const text = current.map((entry) => entry.line).join("\n");
		const startLine = firstEntry.lineNo;
		const endLine = lastEntry.lineNo;
		chunks.push({
			startLine,
			endLine,
			text,
			hash: hashText(text),
			embeddingInput: buildTextEmbeddingInput(text)
		});
	};
	const carryOverlap = () => {
		if (overlapChars <= 0 || current.length === 0) {
			current = [];
			currentChars = 0;
			return;
		}
		let acc = 0;
		const kept = [];
		for (let i = current.length - 1; i >= 0; i -= 1) {
			const entry = current[i];
			if (!entry) continue;
			acc += entry.line.length + 1;
			kept.unshift(entry);
			if (acc >= overlapChars) break;
		}
		current = kept;
		currentChars = kept.reduce((sum, entry) => sum + entry.line.length + 1, 0);
	};
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i] ?? "";
		const lineNo = i + 1;
		const segments = [];
		if (line.length === 0) segments.push("");
		else for (let start = 0; start < line.length; start += maxChars) segments.push(line.slice(start, start + maxChars));
		for (const segment of segments) {
			const lineSize = segment.length + 1;
			if (currentChars + lineSize > maxChars && current.length > 0) {
				flush();
				carryOverlap();
			}
			current.push({
				line: segment,
				lineNo
			});
			currentChars += lineSize;
		}
	}
	flush();
	return chunks;
}
/**
* Remap chunk startLine/endLine from content-relative positions to original
* source file positions using a lineMap.  Each entry in lineMap gives the
* 1-indexed source line for the corresponding 0-indexed content line.
*
* This is used for session JSONL files where buildSessionEntry() flattens
* messages into a plain-text string before chunking.  Without remapping the
* stored line numbers would reference positions in the flattened text rather
* than the original JSONL file.
*/
function remapChunkLines(chunks, lineMap) {
	if (!lineMap || lineMap.length === 0) return;
	for (const chunk of chunks) {
		chunk.startLine = lineMap[chunk.startLine - 1] ?? chunk.startLine;
		chunk.endLine = lineMap[chunk.endLine - 1] ?? chunk.endLine;
	}
}
function parseEmbedding(raw) {
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}
function cosineSimilarity(a, b) {
	if (a.length === 0 || b.length === 0) return 0;
	const len = Math.min(a.length, b.length);
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < len; i += 1) {
		const av = a[i] ?? 0;
		const bv = b[i] ?? 0;
		dot += av * bv;
		normA += av * av;
		normB += bv * bv;
	}
	if (normA === 0 || normB === 0) return 0;
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
async function runWithConcurrency(tasks, limit) {
	const { results, firstError, hasError } = await runTasksWithConcurrency({
		tasks,
		limit,
		errorMode: "stop"
	});
	if (hasError) throw firstError;
	return results;
}
//#endregion
//#region src/memory/session-files.ts
const log = createSubsystemLogger("memory");
async function listSessionFilesForAgent(agentId) {
	const dir = resolveSessionTranscriptsDirForAgent(agentId);
	try {
		return (await fs$1.readdir(dir, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name).filter((name) => name.endsWith(".jsonl")).map((name) => path.join(dir, name));
	} catch {
		return [];
	}
}
function sessionPathForFile(absPath) {
	return path.join("sessions", path.basename(absPath)).replace(/\\/g, "/");
}
function normalizeSessionText(value) {
	return value.replace(/\s*\n+\s*/g, " ").replace(/\s+/g, " ").trim();
}
function extractSessionText(content) {
	if (typeof content === "string") {
		const normalized = normalizeSessionText(content);
		return normalized ? normalized : null;
	}
	if (!Array.isArray(content)) return null;
	const parts = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const record = block;
		if (record.type !== "text" || typeof record.text !== "string") continue;
		const normalized = normalizeSessionText(record.text);
		if (normalized) parts.push(normalized);
	}
	if (parts.length === 0) return null;
	return parts.join(" ");
}
async function buildSessionEntry(absPath) {
	try {
		const stat = await fs$1.stat(absPath);
		const lines = (await fs$1.readFile(absPath, "utf-8")).split("\n");
		const collected = [];
		const lineMap = [];
		for (let jsonlIdx = 0; jsonlIdx < lines.length; jsonlIdx++) {
			const line = lines[jsonlIdx];
			if (!line.trim()) continue;
			let record;
			try {
				record = JSON.parse(line);
			} catch {
				continue;
			}
			if (!record || typeof record !== "object" || record.type !== "message") continue;
			const message = record.message;
			if (!message || typeof message.role !== "string") continue;
			if (message.role !== "user" && message.role !== "assistant") continue;
			const text = extractSessionText(message.content);
			if (!text) continue;
			const safe = redactSensitiveText(text, { mode: "tools" });
			const label = message.role === "user" ? "User" : "Assistant";
			collected.push(`${label}: ${safe}`);
			lineMap.push(jsonlIdx + 1);
		}
		const content = collected.join("\n");
		return {
			path: sessionPathForFile(absPath),
			absPath,
			mtimeMs: stat.mtimeMs,
			size: stat.size,
			hash: hashText(content + "\n" + lineMap.join(",")),
			content,
			lineMap
		};
	} catch (err) {
		log.debug(`Failed reading session file ${absPath}: ${String(err)}`);
		return null;
	}
}
//#endregion
//#region src/infra/warning-filter.ts
const warningFilterKey = Symbol.for("openclaw.warning-filter");
function shouldIgnoreWarning(warning) {
	if (warning.code === "DEP0040" && warning.message?.includes("punycode")) return true;
	if (warning.code === "DEP0060" && warning.message?.includes("util._extend")) return true;
	if (warning.name === "ExperimentalWarning" && warning.message?.includes("SQLite is an experimental feature")) return true;
	return false;
}
function normalizeWarningArgs(args) {
	const warningArg = args[0];
	const secondArg = args[1];
	const thirdArg = args[2];
	let name;
	let code;
	let message;
	if (warningArg instanceof Error) {
		name = warningArg.name;
		message = warningArg.message;
		code = warningArg.code;
	} else if (typeof warningArg === "string") message = warningArg;
	if (secondArg && typeof secondArg === "object" && !Array.isArray(secondArg)) {
		const options = secondArg;
		if (typeof options.type === "string") name = options.type;
		if (typeof options.code === "string") code = options.code;
	} else {
		if (typeof secondArg === "string") name = secondArg;
		if (typeof thirdArg === "string") code = thirdArg;
	}
	return {
		name,
		code,
		message
	};
}
function installProcessWarningFilter() {
	const globalState = globalThis;
	if (globalState[warningFilterKey]?.installed) return;
	const originalEmitWarning = process.emitWarning.bind(process);
	const wrappedEmitWarning = ((...args) => {
		if (shouldIgnoreWarning(normalizeWarningArgs(args))) return;
		return Reflect.apply(originalEmitWarning, process, args);
	});
	process.emitWarning = wrappedEmitWarning;
	globalState[warningFilterKey] = { installed: true };
}
//#endregion
//#region src/memory/sqlite.ts
const require = createRequire(import.meta.url);
function requireNodeSqlite() {
	installProcessWarningFilter();
	try {
		return require("node:sqlite");
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`SQLite support is unavailable in this Node runtime (missing node:sqlite). ${message}`, { cause: err });
	}
}
//#endregion
//#region src/memory/query-expansion.ts
/**
* Query expansion for FTS-only search mode.
*
* When no embedding provider is available, we fall back to FTS (full-text search).
* FTS works best with specific keywords, but users often ask conversational queries
* like "that thing we discussed yesterday" or "之前讨论的那个方案".
*
* This module extracts meaningful keywords from such queries to improve FTS results.
*/
const STOP_WORDS_EN = new Set([
	"a",
	"an",
	"the",
	"this",
	"that",
	"these",
	"those",
	"i",
	"me",
	"my",
	"we",
	"our",
	"you",
	"your",
	"he",
	"she",
	"it",
	"they",
	"them",
	"is",
	"are",
	"was",
	"were",
	"be",
	"been",
	"being",
	"have",
	"has",
	"had",
	"do",
	"does",
	"did",
	"will",
	"would",
	"could",
	"should",
	"can",
	"may",
	"might",
	"in",
	"on",
	"at",
	"to",
	"for",
	"of",
	"with",
	"by",
	"from",
	"about",
	"into",
	"through",
	"during",
	"before",
	"after",
	"above",
	"below",
	"between",
	"under",
	"over",
	"and",
	"or",
	"but",
	"if",
	"then",
	"because",
	"as",
	"while",
	"when",
	"where",
	"what",
	"which",
	"who",
	"how",
	"why",
	"yesterday",
	"today",
	"tomorrow",
	"earlier",
	"later",
	"recently",
	"before",
	"ago",
	"just",
	"now",
	"thing",
	"things",
	"stuff",
	"something",
	"anything",
	"everything",
	"nothing",
	"please",
	"help",
	"find",
	"show",
	"get",
	"tell",
	"give"
]);
const STOP_WORDS_ES = new Set([
	"el",
	"la",
	"los",
	"las",
	"un",
	"una",
	"unos",
	"unas",
	"este",
	"esta",
	"ese",
	"esa",
	"yo",
	"me",
	"mi",
	"nosotros",
	"nosotras",
	"tu",
	"tus",
	"usted",
	"ustedes",
	"ellos",
	"ellas",
	"de",
	"del",
	"a",
	"en",
	"con",
	"por",
	"para",
	"sobre",
	"entre",
	"y",
	"o",
	"pero",
	"si",
	"porque",
	"como",
	"es",
	"son",
	"fue",
	"fueron",
	"ser",
	"estar",
	"haber",
	"tener",
	"hacer",
	"ayer",
	"hoy",
	"mañana",
	"antes",
	"despues",
	"después",
	"ahora",
	"recientemente",
	"que",
	"qué",
	"cómo",
	"cuando",
	"cuándo",
	"donde",
	"dónde",
	"porqué",
	"favor",
	"ayuda"
]);
const STOP_WORDS_PT = new Set([
	"o",
	"a",
	"os",
	"as",
	"um",
	"uma",
	"uns",
	"umas",
	"este",
	"esta",
	"esse",
	"essa",
	"eu",
	"me",
	"meu",
	"minha",
	"nos",
	"nós",
	"você",
	"vocês",
	"ele",
	"ela",
	"eles",
	"elas",
	"de",
	"do",
	"da",
	"em",
	"com",
	"por",
	"para",
	"sobre",
	"entre",
	"e",
	"ou",
	"mas",
	"se",
	"porque",
	"como",
	"é",
	"são",
	"foi",
	"foram",
	"ser",
	"estar",
	"ter",
	"fazer",
	"ontem",
	"hoje",
	"amanhã",
	"antes",
	"depois",
	"agora",
	"recentemente",
	"que",
	"quê",
	"quando",
	"onde",
	"porquê",
	"favor",
	"ajuda"
]);
const STOP_WORDS_AR = new Set([
	"ال",
	"و",
	"أو",
	"لكن",
	"ثم",
	"بل",
	"أنا",
	"نحن",
	"هو",
	"هي",
	"هم",
	"هذا",
	"هذه",
	"ذلك",
	"تلك",
	"هنا",
	"هناك",
	"من",
	"إلى",
	"الى",
	"في",
	"على",
	"عن",
	"مع",
	"بين",
	"ل",
	"ب",
	"ك",
	"كان",
	"كانت",
	"يكون",
	"تكون",
	"صار",
	"أصبح",
	"يمكن",
	"ممكن",
	"بالأمس",
	"امس",
	"اليوم",
	"غدا",
	"الآن",
	"قبل",
	"بعد",
	"مؤخرا",
	"لماذا",
	"كيف",
	"ماذا",
	"متى",
	"أين",
	"هل",
	"من فضلك",
	"فضلا",
	"ساعد"
]);
const STOP_WORDS_KO = new Set([
	"은",
	"는",
	"이",
	"가",
	"을",
	"를",
	"의",
	"에",
	"에서",
	"로",
	"으로",
	"와",
	"과",
	"도",
	"만",
	"까지",
	"부터",
	"한테",
	"에게",
	"께",
	"처럼",
	"같이",
	"보다",
	"마다",
	"밖에",
	"대로",
	"나",
	"나는",
	"내가",
	"나를",
	"너",
	"우리",
	"저",
	"저희",
	"그",
	"그녀",
	"그들",
	"이것",
	"저것",
	"그것",
	"여기",
	"저기",
	"거기",
	"있다",
	"없다",
	"하다",
	"되다",
	"이다",
	"아니다",
	"보다",
	"주다",
	"오다",
	"가다",
	"것",
	"거",
	"등",
	"수",
	"때",
	"곳",
	"중",
	"분",
	"잘",
	"더",
	"또",
	"매우",
	"정말",
	"아주",
	"많이",
	"너무",
	"좀",
	"그리고",
	"하지만",
	"그래서",
	"그런데",
	"그러나",
	"또는",
	"그러면",
	"왜",
	"어떻게",
	"뭐",
	"언제",
	"어디",
	"누구",
	"무엇",
	"어떤",
	"어제",
	"오늘",
	"내일",
	"최근",
	"지금",
	"아까",
	"나중",
	"전에",
	"제발",
	"부탁"
]);
const KO_TRAILING_PARTICLES = [
	"에서",
	"으로",
	"에게",
	"한테",
	"처럼",
	"같이",
	"보다",
	"까지",
	"부터",
	"마다",
	"밖에",
	"대로",
	"은",
	"는",
	"이",
	"가",
	"을",
	"를",
	"의",
	"에",
	"로",
	"와",
	"과",
	"도",
	"만"
].toSorted((a, b) => b.length - a.length);
function stripKoreanTrailingParticle(token) {
	for (const particle of KO_TRAILING_PARTICLES) if (token.length > particle.length && token.endsWith(particle)) return token.slice(0, -particle.length);
	return null;
}
function isUsefulKoreanStem(stem) {
	if (/[\uac00-\ud7af]/.test(stem)) return stem.length >= 2;
	return /^[a-z0-9_]+$/i.test(stem);
}
const STOP_WORDS_JA = new Set([
	"これ",
	"それ",
	"あれ",
	"この",
	"その",
	"あの",
	"ここ",
	"そこ",
	"あそこ",
	"する",
	"した",
	"して",
	"です",
	"ます",
	"いる",
	"ある",
	"なる",
	"できる",
	"の",
	"こと",
	"もの",
	"ため",
	"そして",
	"しかし",
	"また",
	"でも",
	"から",
	"まで",
	"より",
	"だけ",
	"なぜ",
	"どう",
	"何",
	"いつ",
	"どこ",
	"誰",
	"どれ",
	"昨日",
	"今日",
	"明日",
	"最近",
	"今",
	"さっき",
	"前",
	"後"
]);
const STOP_WORDS_ZH = new Set([
	"我",
	"我们",
	"你",
	"你们",
	"他",
	"她",
	"它",
	"他们",
	"这",
	"那",
	"这个",
	"那个",
	"这些",
	"那些",
	"的",
	"了",
	"着",
	"过",
	"得",
	"地",
	"吗",
	"呢",
	"吧",
	"啊",
	"呀",
	"嘛",
	"啦",
	"是",
	"有",
	"在",
	"被",
	"把",
	"给",
	"让",
	"用",
	"到",
	"去",
	"来",
	"做",
	"说",
	"看",
	"找",
	"想",
	"要",
	"能",
	"会",
	"可以",
	"和",
	"与",
	"或",
	"但",
	"但是",
	"因为",
	"所以",
	"如果",
	"虽然",
	"而",
	"也",
	"都",
	"就",
	"还",
	"又",
	"再",
	"才",
	"只",
	"之前",
	"以前",
	"之后",
	"以后",
	"刚才",
	"现在",
	"昨天",
	"今天",
	"明天",
	"最近",
	"东西",
	"事情",
	"事",
	"什么",
	"哪个",
	"哪些",
	"怎么",
	"为什么",
	"多少",
	"请",
	"帮",
	"帮忙",
	"告诉"
]);
function isQueryStopWordToken(token) {
	return STOP_WORDS_EN.has(token) || STOP_WORDS_ES.has(token) || STOP_WORDS_PT.has(token) || STOP_WORDS_AR.has(token) || STOP_WORDS_ZH.has(token) || STOP_WORDS_KO.has(token) || STOP_WORDS_JA.has(token);
}
/**
* Check if a token looks like a meaningful keyword.
* Returns false for short tokens, numbers-only, etc.
*/
function isValidKeyword(token) {
	if (!token || token.length === 0) return false;
	if (/^[a-zA-Z]+$/.test(token) && token.length < 3) return false;
	if (/^\d+$/.test(token)) return false;
	if (/^[\p{P}\p{S}]+$/u.test(token)) return false;
	return true;
}
/**
* Simple tokenizer that handles English, Chinese, Korean, and Japanese text.
* For Chinese, we do character-based splitting since we don't have a proper segmenter.
* For English, we split on whitespace and punctuation.
*/
function tokenize(text) {
	const tokens = [];
	const segments = text.toLowerCase().trim().split(/[\s\p{P}]+/u).filter(Boolean);
	for (const segment of segments) if (/[\u3040-\u30ff]/.test(segment)) {
		const jpParts = segment.match(/[a-z0-9_]+|[\u30a0-\u30ffー]+|[\u4e00-\u9fff]+|[\u3040-\u309f]{2,}/g) ?? [];
		for (const part of jpParts) if (/^[\u4e00-\u9fff]+$/.test(part)) {
			tokens.push(part);
			for (let i = 0; i < part.length - 1; i++) tokens.push(part[i] + part[i + 1]);
		} else tokens.push(part);
	} else if (/[\u4e00-\u9fff]/.test(segment)) {
		const chars = Array.from(segment).filter((c) => /[\u4e00-\u9fff]/.test(c));
		tokens.push(...chars);
		for (let i = 0; i < chars.length - 1; i++) tokens.push(chars[i] + chars[i + 1]);
	} else if (/[\uac00-\ud7af\u3131-\u3163]/.test(segment)) {
		const stem = stripKoreanTrailingParticle(segment);
		const stemIsStopWord = stem !== null && STOP_WORDS_KO.has(stem);
		if (!STOP_WORDS_KO.has(segment) && !stemIsStopWord) tokens.push(segment);
		if (stem && !STOP_WORDS_KO.has(stem) && isUsefulKoreanStem(stem)) tokens.push(stem);
	} else tokens.push(segment);
	return tokens;
}
/**
* Extract keywords from a conversational query for FTS search.
*
* Examples:
* - "that thing we discussed about the API" → ["discussed", "API"]
* - "之前讨论的那个方案" → ["讨论", "方案"]
* - "what was the solution for the bug" → ["solution", "bug"]
*/
function extractKeywords(query) {
	const tokens = tokenize(query);
	const keywords = [];
	const seen = /* @__PURE__ */ new Set();
	for (const token of tokens) {
		if (isQueryStopWordToken(token)) continue;
		if (!isValidKeyword(token)) continue;
		if (seen.has(token)) continue;
		seen.add(token);
		keywords.push(token);
	}
	return keywords;
}
//#endregion
export { appendFileWithinRoot as $, normalizeSkillFilter as $t, supportsMemoryMultimodalEmbeddings as A, isSubagentSessionKey as An, DEFAULT_BOOTSTRAP_FILENAME as At, resolveWindowsSpawnProgram as B, resolveOpenClawPackageRootSync as Bt, isFileMissingError as C, normalizeAccountId as Cn, resolveDefaultAgentId as Ct, getMemoryMultimodalExtensions as D, getSubagentDepth as Dn, resolveSessionAgentIds as Dt, classifyMemoryMultimodalPath as E, deriveSessionChatType as En, resolveSessionAgentId as Et, resolveSessionTranscriptPath as F, DEFAULT_USER_FILENAME as Ft, isAudioFileName as G, markOpenClawExecEnv as Gt, extensionForMime as H, runExec as Ht, resolveSessionTranscriptPathInDir as I, ensureAgentWorkspace as It, normalizeMimeType as J, openBoundaryFileSync as Jt, isGifMedia as K, canUseBoundaryFileOpen as Kt, resolveSessionTranscriptsDirForAgent as L, filterBootstrapFilesForSession as Lt, resolveDefaultSessionStorePath as M, resolveThreadParentSessionKey as Mn, DEFAULT_IDENTITY_FILENAME as Mt, resolveSessionFilePath as N, DEFAULT_SOUL_FILENAME as Nt, isMemoryMultimodalEnabled as O, isAcpSessionKey as On, DEFAULT_AGENTS_FILENAME as Ot, resolveSessionFilePathOptions as P, DEFAULT_TOOLS_FILENAME as Pt, SafeOpenError as Q, normalizeWindowsPathForComparison as Qt, resolveStorePath as R, loadWorkspaceBootstrapFiles as Rt, splitTextToUtf8ByteLimit as S, DEFAULT_ACCOUNT_ID as Sn, resolveAgentWorkspaceDir as St, buildCaseInsensitiveExtensionGlob as T, isBlockedObjectKey as Tn, resolveRunModelFallbacksOverride as Tt, getFileExtension as U, resolveWindowsCommandShim as Ut, detectMime as V, runCommandWithTimeout as Vt, imageMimeFromFormat as W, spawnWithFallback as Wt, maxBytesForKind as X, isNotFoundPathError as Xt, MAX_IMAGE_BYTES as Y, resolvePathViaExistingAncestorSync as Yt, mediaKindFromMime as Z, isPathInside as Zt, remapChunkLines as _, resolveAgentIdFromSessionKey as _n, resolveAgentConfig as _t, listSessionFilesForAgent as a, normalizeHyphenSlug as an, writeFileFromPathWithinRoot as at, estimateStructuredEmbeddingInputBytes as b, scopedHeartbeatWakeOptions as bn, resolveAgentModelFallbacksOverride as bt, buildMultimodalChunkForIndexing as c, DEFAULT_AGENT_ID as cn, assertNoPathAliasEscape as ct, ensureDir as d, buildAgentPeerSessionKey as dn, redactToolDetail as dt, resolveAgentModelFallbackValues as en, copyFileWithinRoot as et, hashText as f, buildGroupHistoryKey as fn, compileSafeRegex as ft, parseEmbedding as g, normalizeMainKey as gn, listAgentIds as gt, normalizeExtraMemoryPaths as h, normalizeAgentId as hn, hasConfiguredModelFallbacks as ht, buildSessionEntry as i, normalizeAtHashSlug as in, readLocalFileSafely as it, resolveAgentsDirFromSessionStorePath as j, parseAgentSessionKey as jn, DEFAULT_HEARTBEAT_FILENAME as jt, normalizeMemoryMultimodalSettings as k, isCronSessionKey as kn, DEFAULT_AGENT_WORKSPACE_DIR as kt, chunkMarkdown as l, DEFAULT_MAIN_KEY as ln, getDefaultRedactPatterns as lt, listMemoryFiles as m, isValidAgentId as mn, runTasksWithConcurrency as mt, isQueryStopWordToken as n, toAgentModelListLike as nn, openFileWithinRoot as nt, sessionPathForFile as o, normalizeStringEntries as on, writeFileWithinRoot as ot, isMemoryPath as p, classifySessionKeyShape as pn, testRegexWithBoundedInput as pt, kindFromMime as q, openBoundaryFile as qt, requireNodeSqlite as r, openVerifiedFileSync as rn, readFileWithinRoot as rt, buildFileEntry as s, normalizeStringEntriesLower as sn, PATH_ALIAS_POLICIES as st, extractKeywords as t, resolveAgentModelPrimaryValue as tn, createRootScopedReadFile as tt, cosineSimilarity as u, buildAgentMainSessionKey as un, redactSensitiveText as ut, runWithConcurrency as v, resolveThreadSessionKeys as vn, resolveAgentDir as vt, statRegularFile as w, normalizeOptionalAccountId as wn, resolveEffectiveModelFallbacks as wt, estimateUtf8Bytes as x, toAgentRequestSessionKey as xn, resolveAgentSkillsFilter as xt, hasNonTextEmbeddingParts as y, sanitizeAgentId as yn, resolveAgentEffectiveModelPrimary as yt, materializeWindowsSpawnProgram as z, resolveOpenClawPackageRoot as zt };
