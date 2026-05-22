import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
//#region src/infra/scp-host.ts
const SSH_TOKEN = /^[A-Za-z0-9._-]+$/;
const BRACKETED_IPV6 = /^\[[0-9A-Fa-f:.%]+\]$/;
const WHITESPACE = /\s/;
const SCP_REMOTE_PATH_UNSAFE_CHARS = new Set([
	"\\",
	"'",
	"\"",
	"`",
	"$",
	";",
	"|",
	"&",
	"<",
	">"
]);
function hasControlOrWhitespace(value) {
	for (const char of value) {
		const code = char.charCodeAt(0);
		if (code <= 31 || code === 127 || WHITESPACE.test(char)) return true;
	}
	return false;
}
function normalizeScpRemoteHost(value) {
	const trimmed = normalizeOptionalString(value);
	if (!trimmed) return;
	if (hasControlOrWhitespace(trimmed)) return;
	if (trimmed.startsWith("-") || trimmed.includes("/") || trimmed.includes("\\")) return;
	const firstAt = trimmed.indexOf("@");
	const lastAt = trimmed.lastIndexOf("@");
	let user;
	let host = trimmed;
	if (firstAt !== -1) {
		if (firstAt !== lastAt || firstAt === 0 || firstAt === trimmed.length - 1) return;
		user = trimmed.slice(0, firstAt);
		host = trimmed.slice(firstAt + 1);
		if (!SSH_TOKEN.test(user)) return;
	}
	if (!host || host.startsWith("-") || host.includes("@")) return;
	if (host.includes(":") && !BRACKETED_IPV6.test(host)) return;
	if (!SSH_TOKEN.test(host) && !BRACKETED_IPV6.test(host)) return;
	return user ? `${user}@${host}` : host;
}
function isSafeScpRemoteHost(value) {
	return normalizeScpRemoteHost(value) !== void 0;
}
function normalizeScpRemotePath(value) {
	const trimmed = normalizeOptionalString(value);
	if (!trimmed || !trimmed.startsWith("/")) return;
	for (const char of trimmed) {
		const code = char.charCodeAt(0);
		if (code <= 31 || code === 127 || SCP_REMOTE_PATH_UNSAFE_CHARS.has(char)) return;
	}
	return trimmed;
}
function isSafeScpRemotePath(value) {
	return normalizeScpRemotePath(value) !== void 0;
}
//#endregion
export { normalizeScpRemotePath as i, isSafeScpRemotePath as n, normalizeScpRemoteHost as r, isSafeScpRemoteHost as t };
