import crypto from "node:crypto";
export const NOVNC_PASSWORD_ENV_KEY = "OPENCLAW_BROWSER_NOVNC_PASSWORD";
const NOVNC_TOKEN_TTL_MS = 60 * 1000;
const NOVNC_PASSWORD_LENGTH = 8;
const NOVNC_PASSWORD_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const NO_VNC_OBSERVER_TOKENS = new Map();
function pruneExpiredNoVncObserverTokens(now) {
    for (const [token, entry] of NO_VNC_OBSERVER_TOKENS) {
        if (entry.expiresAt <= now) {
            NO_VNC_OBSERVER_TOKENS.delete(token);
        }
    }
}
export function isNoVncEnabled(params) {
    return params.enableNoVnc && !params.headless;
}
export function generateNoVncPassword() {
    // VNC auth uses an 8-char password max.
    let out = "";
    for (let i = 0; i < NOVNC_PASSWORD_LENGTH; i += 1) {
        out += NOVNC_PASSWORD_ALPHABET[crypto.randomInt(0, NOVNC_PASSWORD_ALPHABET.length)];
    }
    return out;
}
export function buildNoVncDirectUrl(port) {
    return `http://127.0.0.1:${port}/vnc.html`;
}
export function buildNoVncObserverTargetUrl(params) {
    const query = new URLSearchParams({
        autoconnect: "1",
        resize: "remote",
    });
    if (params.password?.trim()) {
        query.set("password", params.password);
    }
    return `${buildNoVncDirectUrl(params.port)}#${query.toString()}`;
}
export function issueNoVncObserverToken(params) {
    const now = params.nowMs ?? Date.now();
    pruneExpiredNoVncObserverTokens(now);
    const token = crypto.randomBytes(24).toString("hex");
    NO_VNC_OBSERVER_TOKENS.set(token, {
        noVncPort: params.noVncPort,
        password: params.password?.trim() || undefined,
        expiresAt: now + Math.max(1, params.ttlMs ?? NOVNC_TOKEN_TTL_MS),
    });
    return token;
}
export function consumeNoVncObserverToken(token, nowMs) {
    const now = nowMs ?? Date.now();
    pruneExpiredNoVncObserverTokens(now);
    const normalized = token.trim();
    if (!normalized) {
        return null;
    }
    const entry = NO_VNC_OBSERVER_TOKENS.get(normalized);
    if (!entry) {
        return null;
    }
    NO_VNC_OBSERVER_TOKENS.delete(normalized);
    if (entry.expiresAt <= now) {
        return null;
    }
    return { noVncPort: entry.noVncPort, password: entry.password };
}
export function buildNoVncObserverTokenUrl(baseUrl, token) {
    const query = new URLSearchParams({ token });
    return `${baseUrl}/sandbox/novnc?${query.toString()}`;
}
export function resetNoVncObserverTokensForTests() {
    NO_VNC_OBSERVER_TOKENS.clear();
}
