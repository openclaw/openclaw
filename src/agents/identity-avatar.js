import fs from "node:fs";
import path from "node:path";
import { AVATAR_MAX_BYTES, hasAvatarUriScheme, isAvatarDataUrl, isAvatarHttpUrl, isWindowsAbsolutePath, isPathWithinRoot, isSupportedLocalAvatarExtension, } from "../shared/avatar-policy.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { resolveUserPath } from "../utils.js";
import { resolveAgentWorkspaceDir } from "./agent-scope.js";
import { loadAgentIdentityFromWorkspace } from "./identity-file.js";
import { resolveAgentIdentity } from "./identity.js";
const PUBLIC_AVATAR_SOURCE_MAX_CHARS = 256;
const PUBLIC_DATA_AVATAR_HEADER_MAX_CHARS = 64;
function resolveAvatarSource(cfg, agentId, opts) {
    if (opts?.includeUiOverride) {
        const fromUiConfig = normalizeOptionalString(cfg.ui?.assistant?.avatar) ?? null;
        if (fromUiConfig) {
            return fromUiConfig;
        }
    }
    const fromConfig = normalizeOptionalString(resolveAgentIdentity(cfg, agentId)?.avatar) ?? null;
    if (fromConfig) {
        return fromConfig;
    }
    const workspace = resolveAgentWorkspaceDir(cfg, agentId);
    const fromIdentity = normalizeOptionalString(loadAgentIdentityFromWorkspace(workspace)?.avatar) ?? null;
    return fromIdentity;
}
function resolveExistingPath(value) {
    try {
        return fs.realpathSync(value);
    }
    catch {
        return path.resolve(value);
    }
}
function resolveLocalAvatarPath(params) {
    const workspaceRoot = resolveExistingPath(params.workspaceDir);
    const raw = params.raw;
    const resolved = raw.startsWith("~") || path.isAbsolute(raw)
        ? resolveUserPath(raw)
        : path.resolve(workspaceRoot, raw);
    const realPath = resolveExistingPath(resolved);
    if (!isPathWithinRoot(workspaceRoot, realPath)) {
        return { ok: false, reason: "outside_workspace" };
    }
    if (!isSupportedLocalAvatarExtension(realPath)) {
        return { ok: false, reason: "unsupported_extension" };
    }
    try {
        const stat = fs.statSync(realPath);
        if (!stat.isFile()) {
            return { ok: false, reason: "missing" };
        }
        if (stat.size > AVATAR_MAX_BYTES) {
            return { ok: false, reason: "too_large" };
        }
    }
    catch {
        return { ok: false, reason: "missing" };
    }
    return { ok: true, filePath: realPath };
}
function isSafeRelativeAvatarSource(source) {
    if (source.length > PUBLIC_AVATAR_SOURCE_MAX_CHARS ||
        source.startsWith("~") ||
        path.isAbsolute(source) ||
        isWindowsAbsolutePath(source) ||
        (hasAvatarUriScheme(source) && !isWindowsAbsolutePath(source)) ||
        source.includes("\0")) {
        return false;
    }
    const parts = source.replace(/\\/g, "/").split("/");
    return parts.every((part) => part !== "..");
}
export function resolvePublicAgentAvatarSource(resolved) {
    const source = normalizeOptionalString(resolved.source) ?? null;
    if (!source) {
        return undefined;
    }
    if (isAvatarDataUrl(source)) {
        const commaIndex = source.indexOf(",");
        const header = commaIndex > 0
            ? source.slice(0, Math.min(commaIndex, PUBLIC_DATA_AVATAR_HEADER_MAX_CHARS))
            : source.slice(0, PUBLIC_DATA_AVATAR_HEADER_MAX_CHARS);
        return `${header},...`;
    }
    if (isAvatarHttpUrl(source)) {
        return "remote URL";
    }
    return isSafeRelativeAvatarSource(source) ? source : undefined;
}
export function resolveAgentAvatar(cfg, agentId, opts) {
    const source = resolveAvatarSource(cfg, agentId, opts);
    if (!source) {
        return { kind: "none", reason: "missing" };
    }
    if (isAvatarHttpUrl(source)) {
        return { kind: "remote", url: source, source };
    }
    if (isAvatarDataUrl(source)) {
        return { kind: "data", url: source, source };
    }
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const resolved = resolveLocalAvatarPath({ raw: source, workspaceDir });
    if (!resolved.ok) {
        return { kind: "none", reason: resolved.reason, source };
    }
    return { kind: "local", filePath: resolved.filePath, source };
}
