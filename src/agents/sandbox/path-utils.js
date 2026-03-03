import path from "node:path";
export function normalizeContainerPath(value) {
    const normalized = path.posix.normalize(value);
    return normalized === "." ? "/" : normalized;
}
export function isPathInsideContainerRoot(root, target) {
    const normalizedRoot = normalizeContainerPath(root);
    const normalizedTarget = normalizeContainerPath(target);
    if (normalizedRoot === "/") {
        return true;
    }
    return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`);
}
