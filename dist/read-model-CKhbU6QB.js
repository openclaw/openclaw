import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import "./account-id-B32J-iNN.js";
import { a as asRecord } from "./record-coerce-aMlBWINm.js";
import { t as hasConfiguredUnavailableCredentialStatus } from "./account-snapshot-fields-YzCGlwrq.js";
//#region src/channels/status/read-model.ts
const CREDENTIAL_STATUS_KEYS = [
	"tokenStatus",
	"botTokenStatus",
	"appTokenStatus",
	"signingSecretStatus",
	"userTokenStatus"
];
function readRuntimeAccountsByChannel(payload) {
	return asRecord(asRecord(payload).channelAccounts);
}
function getRuntimeChannelAccounts(params) {
	const raw = readRuntimeAccountsByChannel(params.payload)[params.channelId];
	return Array.isArray(raw) ? raw.map(asRecord) : [];
}
function normalizeRuntimeChannelAccountSnapshots(payload) {
	const out = /* @__PURE__ */ new Map();
	for (const [channelId, accounts] of Object.entries(readRuntimeAccountsByChannel(payload))) {
		if (!Array.isArray(accounts)) continue;
		const normalized = accounts.filter((account) => Boolean(account) && typeof account === "object" && typeof account.accountId === "string");
		if (normalized.length > 0) out.set(channelId, normalized);
	}
	return out;
}
function resolveRuntimeChannelAccountId(account) {
	return normalizeOptionalString(account.accountId) ?? normalizeOptionalString(account.id) ?? normalizeOptionalString(account.name) ?? "default";
}
function findRuntimeChannelAccount(params) {
	return params.liveAccounts.find((account) => resolveRuntimeChannelAccountId(account) === params.accountId) ?? (params.accountId === "default" && params.liveAccounts.length === 1 ? params.liveAccounts[0] ?? null : null);
}
function hasRuntimeCredentialAvailable(params) {
	const account = findRuntimeChannelAccount(params);
	if (!account) return false;
	if (hasConfiguredUnavailableCredentialStatus(account)) return false;
	return account.running === true || account.connected === true;
}
function markConfiguredUnavailableCredentialStatusesAvailable(account) {
	const record = { ...asRecord(account) };
	for (const key of CREDENTIAL_STATUS_KEYS) if (record[key] === "configured_unavailable") record[key] = "available";
	return record;
}
async function resolveChannelAccountStatusRows(params) {
	const mergedAccountIds = [...new Set([...params.localAccountIds, ...params.runtimeAccounts.map((account) => account.accountId)])];
	const rows = [];
	for (const accountId of mergedAccountIds) {
		const runtimeSnapshot = params.runtimeAccounts.find((account) => account.accountId === accountId);
		rows.push({
			accountId,
			snapshot: runtimeSnapshot ?? await params.resolveLocalSnapshot(accountId),
			source: runtimeSnapshot ? "gateway" : "config"
		});
	}
	return rows;
}
//#endregion
export { resolveChannelAccountStatusRows as a, normalizeRuntimeChannelAccountSnapshots as i, hasRuntimeCredentialAvailable as n, markConfiguredUnavailableCredentialStatusesAvailable as r, getRuntimeChannelAccounts as t };
