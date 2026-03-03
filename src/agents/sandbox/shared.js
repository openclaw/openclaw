import path from "node:path";
import { normalizeAgentId } from "../../routing/session-key.js";
import { resolveUserPath } from "../../utils.js";
import { resolveAgentIdFromSessionKey } from "../agent-scope.js";
import { hashTextSha256 } from "./hash.js";
export function slugifySessionKey(value) {
    const trimmed = value.trim() || "session";
    const hash = hashTextSha256(trimmed).slice(0, 8);
    const safe = trimmed
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "");
    const base = safe.slice(0, 32) || "session";
    return `${base}-${hash}`;
}
export function resolveSandboxWorkspaceDir(root, sessionKey) {
    const resolvedRoot = resolveUserPath(root);
    const slug = slugifySessionKey(sessionKey);
    return path.join(resolvedRoot, slug);
}
export function resolveSandboxScopeKey(scope, sessionKey) {
    const trimmed = sessionKey.trim() || "main";
    if (scope === "shared") {
        return "shared";
    }
    if (scope === "session") {
        return trimmed;
    }
    const agentId = resolveAgentIdFromSessionKey(trimmed);
    return `agent:${agentId}`;
}
export function resolveSandboxAgentId(scopeKey) {
    const trimmed = scopeKey.trim();
    if (!trimmed || trimmed === "shared") {
        return undefined;
    }
    const parts = trimmed.split(":").filter(Boolean);
    if (parts[0] === "agent" && parts[1]) {
        return normalizeAgentId(parts[1]);
    }
    return resolveAgentIdFromSessionKey(trimmed);
}
