import { t as formatCliCommand } from "./command-format-CDHXQh1_.js";
import { m as DEFAULT_ACCOUNT_ID } from "./session-key-qmb11-mH.js";
import crypto from "node:crypto";

//#region src/logging/redact-identifier.ts
function sha256HexPrefix(value, len = 12) {
	const safeLen = Number.isFinite(len) ? Math.max(1, Math.floor(len)) : 12;
	return crypto.createHash("sha256").update(value).digest("hex").slice(0, safeLen);
}
function redactIdentifier(value, opts) {
	const trimmed = value?.trim();
	if (!trimmed) return "-";
	return `sha256:${sha256HexPrefix(trimmed, opts?.len ?? 12)}`;
}

//#endregion
//#region src/web/active-listener.ts
const listeners = /* @__PURE__ */ new Map();
function resolveWebAccountId(accountId) {
	return (accountId ?? "").trim() || DEFAULT_ACCOUNT_ID;
}
function requireActiveWebListener(accountId) {
	const id = resolveWebAccountId(accountId);
	const listener = listeners.get(id) ?? null;
	if (!listener) throw new Error(`No active WhatsApp Web listener (account: ${id}). Start the gateway, then link WhatsApp with: ${formatCliCommand(`openclaw channels login --channel whatsapp --account ${id}`)}.`);
	return {
		accountId: id,
		listener
	};
}
function setActiveWebListener(accountIdOrListener, maybeListener) {
	const { accountId, listener } = typeof accountIdOrListener === "string" ? {
		accountId: accountIdOrListener,
		listener: maybeListener ?? null
	} : {
		accountId: DEFAULT_ACCOUNT_ID,
		listener: accountIdOrListener ?? null
	};
	const id = resolveWebAccountId(accountId);
	if (!listener) listeners.delete(id);
	else listeners.set(id, listener);
	if (id === DEFAULT_ACCOUNT_ID) {}
}
function getActiveWebListener(accountId) {
	const id = resolveWebAccountId(accountId);
	return listeners.get(id) ?? null;
}

//#endregion
export { sha256HexPrefix as a, redactIdentifier as i, requireActiveWebListener as n, setActiveWebListener as r, getActiveWebListener as t };