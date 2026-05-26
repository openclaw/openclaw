import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { p as resolveUserPath } from "./utils-sBTEdeml.js";
import "./agent-scope-CtLXGcWm.js";
import { l as normalizeAgentId } from "./session-key-Bte0mmcq.js";
import { c as resolveDefaultAgentId, o as resolveAgentWorkspaceDir } from "./agent-scope-config-CMp71_27.js";
import { c as isWindowsAbsolutePath, i as isAvatarHttpUrl, n as hasAvatarUriScheme, o as isPathWithinRoot, r as isAvatarDataUrl, s as isSupportedLocalAvatarExtension } from "./avatar-policy-BSD55fx7.js";
import { n as resolveAgentIdentity } from "./identity-nYw-h8DL.js";
import { n as loadAgentIdentityFromWorkspace } from "./identity-file-BfwiD4th.js";
import fs from "node:fs";
import path from "node:path";
//#region src/agents/identity-avatar.ts
const PUBLIC_AVATAR_SOURCE_MAX_CHARS = 256;
const PUBLIC_DATA_AVATAR_HEADER_MAX_CHARS = 64;
function resolveAvatarSource(cfg, agentId, opts) {
	const normalizedAgentId = normalizeAgentId(agentId);
	const defaultAgentId = normalizeAgentId(resolveDefaultAgentId(cfg));
	const fromUiConfig = normalizeOptionalString(cfg.ui?.assistant?.avatar) ?? null;
	if (opts?.includeUiOverride) {
		if (normalizedAgentId === defaultAgentId && fromUiConfig) return fromUiConfig;
	}
	const fromConfig = normalizeOptionalString(resolveAgentIdentity(cfg, normalizedAgentId)?.avatar) ?? null;
	if (fromConfig) return fromConfig;
	const fromIdentity = normalizeOptionalString(loadAgentIdentityFromWorkspace(resolveAgentWorkspaceDir(cfg, normalizedAgentId))?.avatar) ?? null;
	if (fromIdentity) return fromIdentity;
	return opts?.includeUiOverride ? fromUiConfig : null;
}
function resolveExistingPath(value) {
	try {
		return fs.realpathSync(value);
	} catch {
		return path.resolve(value);
	}
}
function resolveLocalAvatarPath(params) {
	const workspaceRoot = resolveExistingPath(params.workspaceDir);
	const raw = params.raw;
	const realPath = resolveExistingPath(raw.startsWith("~") || path.isAbsolute(raw) ? resolveUserPath(raw) : path.resolve(workspaceRoot, raw));
	if (!isPathWithinRoot(workspaceRoot, realPath)) return {
		ok: false,
		reason: "outside_workspace"
	};
	if (!isSupportedLocalAvatarExtension(realPath)) return {
		ok: false,
		reason: "unsupported_extension"
	};
	try {
		const stat = fs.statSync(realPath);
		if (!stat.isFile()) return {
			ok: false,
			reason: "missing"
		};
		if (stat.size > 2097152) return {
			ok: false,
			reason: "too_large"
		};
	} catch {
		return {
			ok: false,
			reason: "missing"
		};
	}
	return {
		ok: true,
		filePath: realPath
	};
}
function isSafeRelativeAvatarSource(source) {
	if (source.length > PUBLIC_AVATAR_SOURCE_MAX_CHARS || source.startsWith("~") || path.isAbsolute(source) || isWindowsAbsolutePath(source) || hasAvatarUriScheme(source) && !isWindowsAbsolutePath(source) || source.includes("\0")) return false;
	return source.replace(/\\/g, "/").split("/").every((part) => part !== "..");
}
function resolvePublicAgentAvatarSource(resolved) {
	const source = normalizeOptionalString(resolved.source) ?? null;
	if (!source) return;
	if (isAvatarDataUrl(source)) {
		const commaIndex = source.indexOf(",");
		return `${commaIndex > 0 ? source.slice(0, Math.min(commaIndex, PUBLIC_DATA_AVATAR_HEADER_MAX_CHARS)) : source.slice(0, PUBLIC_DATA_AVATAR_HEADER_MAX_CHARS)},...`;
	}
	if (isAvatarHttpUrl(source)) return "remote URL";
	return isSafeRelativeAvatarSource(source) ? source : void 0;
}
function resolveAgentAvatar(cfg, agentId, opts) {
	const source = resolveAvatarSource(cfg, agentId, opts);
	if (!source) return {
		kind: "none",
		reason: "missing"
	};
	if (isAvatarHttpUrl(source)) return {
		kind: "remote",
		url: source,
		source
	};
	if (isAvatarDataUrl(source)) return {
		kind: "data",
		url: source,
		source
	};
	const resolved = resolveLocalAvatarPath({
		raw: source,
		workspaceDir: resolveAgentWorkspaceDir(cfg, agentId)
	});
	if (!resolved.ok) return {
		kind: "none",
		reason: resolved.reason,
		source
	};
	return {
		kind: "local",
		filePath: resolved.filePath,
		source
	};
}
//#endregion
export { resolvePublicAgentAvatarSource as n, resolveAgentAvatar as t };
