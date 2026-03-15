//#region src/shared/net/url-userinfo.ts
function stripUrlUserInfo(value) {
	try {
		const parsed = new URL(value);
		if (!parsed.username && !parsed.password) {return value;}
		parsed.username = "";
		parsed.password = "";
		return parsed.toString();
	} catch {
		return value;
	}
}
//#endregion
//#region src/channels/account-snapshot-fields.ts
const CREDENTIAL_STATUS_KEYS = [
	"tokenStatus",
	"botTokenStatus",
	"appTokenStatus",
	"signingSecretStatus",
	"userTokenStatus"
];
function asRecord(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {return null;}
	return value;
}
function readTrimmedString(record, key) {
	const value = record[key];
	if (typeof value !== "string") {return;}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function readBoolean(record, key) {
	return typeof record[key] === "boolean" ? record[key] : void 0;
}
function readNumber(record, key) {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function readStringArray(record, key) {
	const value = record[key];
	if (!Array.isArray(value)) {return;}
	const normalized = value.map((entry) => typeof entry === "string" || typeof entry === "number" ? String(entry) : "").map((entry) => entry.trim()).filter(Boolean);
	return normalized.length > 0 ? normalized : void 0;
}
function readCredentialStatus(record, key) {
	const value = record[key];
	return value === "available" || value === "configured_unavailable" || value === "missing" ? value : void 0;
}
function resolveConfiguredFromCredentialStatuses(account) {
	const record = asRecord(account);
	if (!record) {return;}
	let sawCredentialStatus = false;
	for (const key of CREDENTIAL_STATUS_KEYS) {
		const status = readCredentialStatus(record, key);
		if (!status) {continue;}
		sawCredentialStatus = true;
		if (status !== "missing") {return true;}
	}
	return sawCredentialStatus ? false : void 0;
}
function resolveConfiguredFromRequiredCredentialStatuses(account, requiredKeys) {
	const record = asRecord(account);
	if (!record) {return;}
	let sawCredentialStatus = false;
	for (const key of requiredKeys) {
		const status = readCredentialStatus(record, key);
		if (!status) {continue;}
		sawCredentialStatus = true;
		if (status === "missing") {return false;}
	}
	return sawCredentialStatus ? true : void 0;
}
function hasConfiguredUnavailableCredentialStatus(account) {
	const record = asRecord(account);
	if (!record) {return false;}
	return CREDENTIAL_STATUS_KEYS.some((key) => readCredentialStatus(record, key) === "configured_unavailable");
}
function hasResolvedCredentialValue(account) {
	const record = asRecord(account);
	if (!record) {return false;}
	return [
		"token",
		"botToken",
		"appToken",
		"signingSecret",
		"userToken"
	].some((key) => {
		const value = record[key];
		return typeof value === "string" && value.trim().length > 0;
	}) || CREDENTIAL_STATUS_KEYS.some((key) => readCredentialStatus(record, key) === "available");
}
function projectCredentialSnapshotFields(account) {
	const record = asRecord(account);
	if (!record) {return {};}
	return {
		...readTrimmedString(record, "tokenSource") ? { tokenSource: readTrimmedString(record, "tokenSource") } : {},
		...readTrimmedString(record, "botTokenSource") ? { botTokenSource: readTrimmedString(record, "botTokenSource") } : {},
		...readTrimmedString(record, "appTokenSource") ? { appTokenSource: readTrimmedString(record, "appTokenSource") } : {},
		...readTrimmedString(record, "signingSecretSource") ? { signingSecretSource: readTrimmedString(record, "signingSecretSource") } : {},
		...readCredentialStatus(record, "tokenStatus") ? { tokenStatus: readCredentialStatus(record, "tokenStatus") } : {},
		...readCredentialStatus(record, "botTokenStatus") ? { botTokenStatus: readCredentialStatus(record, "botTokenStatus") } : {},
		...readCredentialStatus(record, "appTokenStatus") ? { appTokenStatus: readCredentialStatus(record, "appTokenStatus") } : {},
		...readCredentialStatus(record, "signingSecretStatus") ? { signingSecretStatus: readCredentialStatus(record, "signingSecretStatus") } : {},
		...readCredentialStatus(record, "userTokenStatus") ? { userTokenStatus: readCredentialStatus(record, "userTokenStatus") } : {}
	};
}
function projectSafeChannelAccountSnapshotFields(account) {
	const record = asRecord(account);
	if (!record) {return {};}
	return {
		...readTrimmedString(record, "name") ? { name: readTrimmedString(record, "name") } : {},
		...readBoolean(record, "linked") !== void 0 ? { linked: readBoolean(record, "linked") } : {},
		...readBoolean(record, "running") !== void 0 ? { running: readBoolean(record, "running") } : {},
		...readBoolean(record, "connected") !== void 0 ? { connected: readBoolean(record, "connected") } : {},
		...readNumber(record, "reconnectAttempts") !== void 0 ? { reconnectAttempts: readNumber(record, "reconnectAttempts") } : {},
		...readTrimmedString(record, "mode") ? { mode: readTrimmedString(record, "mode") } : {},
		...readTrimmedString(record, "dmPolicy") ? { dmPolicy: readTrimmedString(record, "dmPolicy") } : {},
		...readStringArray(record, "allowFrom") ? { allowFrom: readStringArray(record, "allowFrom") } : {},
		...projectCredentialSnapshotFields(account),
		...readTrimmedString(record, "baseUrl") ? { baseUrl: stripUrlUserInfo(readTrimmedString(record, "baseUrl")) } : {},
		...readBoolean(record, "allowUnmentionedGroups") !== void 0 ? { allowUnmentionedGroups: readBoolean(record, "allowUnmentionedGroups") } : {},
		...readTrimmedString(record, "cliPath") ? { cliPath: readTrimmedString(record, "cliPath") } : {},
		...readTrimmedString(record, "dbPath") ? { dbPath: readTrimmedString(record, "dbPath") } : {},
		...readNumber(record, "port") !== void 0 ? { port: readNumber(record, "port") } : {}
	};
}
//#endregion
export { resolveConfiguredFromCredentialStatuses as a, projectSafeChannelAccountSnapshotFields as i, hasResolvedCredentialValue as n, resolveConfiguredFromRequiredCredentialStatuses as o, projectCredentialSnapshotFields as r, stripUrlUserInfo as s, hasConfiguredUnavailableCredentialStatus as t };
