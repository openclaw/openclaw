import fs from "node:fs";
import path from "node:path";
import { DEFAULT_IDENTITY_FILENAME } from "./workspace.js";
const IDENTITY_PLACEHOLDER_VALUES = new Set([
    "pick something you like",
    "ai? robot? familiar? ghost in the machine? something weirder?",
    "how do you come across? sharp? warm? chaotic? calm?",
    "your signature - pick one that feels right",
    "workspace-relative path, http(s) url, or data uri",
]);
function normalizeIdentityValue(value) {
    let normalized = value.trim();
    normalized = normalized.replace(/^[*_]+|[*_]+$/g, "").trim();
    if (normalized.startsWith("(") && normalized.endsWith(")")) {
        normalized = normalized.slice(1, -1).trim();
    }
    normalized = normalized.replace(/[\u2013\u2014]/g, "-");
    normalized = normalized.replace(/\s+/g, " ").toLowerCase();
    return normalized;
}
function isIdentityPlaceholder(value) {
    const normalized = normalizeIdentityValue(value);
    return IDENTITY_PLACEHOLDER_VALUES.has(normalized);
}
export function parseIdentityMarkdown(content) {
    const identity = {};
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
        const cleaned = line.trim().replace(/^\s*-\s*/, "");
        const colonIndex = cleaned.indexOf(":");
        if (colonIndex === -1) {
            continue;
        }
        const label = cleaned.slice(0, colonIndex).replace(/[*_]/g, "").trim().toLowerCase();
        const value = cleaned
            .slice(colonIndex + 1)
            .replace(/^[*_]+|[*_]+$/g, "")
            .trim();
        if (!value) {
            continue;
        }
        if (isIdentityPlaceholder(value)) {
            continue;
        }
        if (label === "name") {
            identity.name = value;
        }
        if (label === "emoji") {
            identity.emoji = value;
        }
        if (label === "creature") {
            identity.creature = value;
        }
        if (label === "vibe") {
            identity.vibe = value;
        }
        if (label === "theme") {
            identity.theme = value;
        }
        if (label === "avatar") {
            identity.avatar = value;
        }
    }
    return identity;
}
export function identityHasValues(identity) {
    return Boolean(identity.name ||
        identity.emoji ||
        identity.theme ||
        identity.creature ||
        identity.vibe ||
        identity.avatar);
}
export function loadIdentityFromFile(identityPath) {
    try {
        const content = fs.readFileSync(identityPath, "utf-8");
        const parsed = parseIdentityMarkdown(content);
        if (!identityHasValues(parsed)) {
            return null;
        }
        return parsed;
    }
    catch {
        return null;
    }
}
export function loadAgentIdentityFromWorkspace(workspace) {
    const identityPath = path.join(workspace, DEFAULT_IDENTITY_FILENAME);
    return loadIdentityFromFile(identityPath);
}
