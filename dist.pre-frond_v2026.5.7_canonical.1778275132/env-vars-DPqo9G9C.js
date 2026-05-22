import { n as normalizeAccountId, r as normalizeOptionalAccountId } from "./account-id-Bj7l9NI7.js";
//#region extensions/matrix/src/env-vars.ts
const MATRIX_SCOPED_ENV_SUFFIXES = [
	"HOMESERVER",
	"USER_ID",
	"ACCESS_TOKEN",
	"PASSWORD",
	"DEVICE_ID",
	"DEVICE_NAME"
];
const MATRIX_GLOBAL_ENV_KEYS = MATRIX_SCOPED_ENV_SUFFIXES.map((suffix) => `MATRIX_${suffix}`);
const MATRIX_SCOPED_ENV_RE = new RegExp(`^MATRIX_(.+)_(${MATRIX_SCOPED_ENV_SUFFIXES.join("|")})$`);
function resolveMatrixEnvAccountToken(accountId) {
	return Array.from(normalizeAccountId(accountId)).map((char) => /[a-z0-9]/.test(char) ? char.toUpperCase() : `_X${char.codePointAt(0)?.toString(16).toUpperCase() ?? "00"}_`).join("");
}
function getMatrixScopedEnvVarNames(accountId) {
	const token = resolveMatrixEnvAccountToken(accountId);
	return {
		homeserver: `MATRIX_${token}_HOMESERVER`,
		userId: `MATRIX_${token}_USER_ID`,
		accessToken: `MATRIX_${token}_ACCESS_TOKEN`,
		password: `MATRIX_${token}_PASSWORD`,
		deviceId: `MATRIX_${token}_DEVICE_ID`,
		deviceName: `MATRIX_${token}_DEVICE_NAME`
	};
}
function decodeMatrixEnvAccountToken(token) {
	let decoded = "";
	for (let index = 0; index < token.length;) {
		const hexEscape = /^_X([0-9A-F]+)_/.exec(token.slice(index));
		if (hexEscape) {
			const hex = hexEscape[1];
			const codePoint = hex ? Number.parseInt(hex, 16) : NaN;
			if (!Number.isFinite(codePoint)) return;
			decoded += String.fromCodePoint(codePoint);
			index += hexEscape[0].length;
			continue;
		}
		const char = token[index];
		if (!char || !/[A-Z0-9]/.test(char)) return;
		decoded += char.toLowerCase();
		index += 1;
	}
	const normalized = normalizeOptionalAccountId(decoded);
	if (!normalized) return;
	return resolveMatrixEnvAccountToken(normalized) === token ? normalized : void 0;
}
function listMatrixEnvAccountIds(env = process.env) {
	const ids = /* @__PURE__ */ new Set();
	for (const key of MATRIX_GLOBAL_ENV_KEYS) if (typeof env[key] === "string" && env[key]?.trim()) {
		ids.add(normalizeAccountId("default"));
		break;
	}
	for (const key of Object.keys(env)) {
		const match = MATRIX_SCOPED_ENV_RE.exec(key);
		if (!match) continue;
		const accountId = decodeMatrixEnvAccountToken(match[1]);
		if (accountId) ids.add(accountId);
	}
	return Array.from(ids).toSorted((a, b) => a.localeCompare(b));
}
//#endregion
export { listMatrixEnvAccountIds as n, resolveMatrixEnvAccountToken as r, getMatrixScopedEnvVarNames as t };
