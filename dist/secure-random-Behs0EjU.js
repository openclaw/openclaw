import { n as normalizeAccountId } from "./account-id-JwW97xNZ.js";
import { t as createAccountListHelpers } from "./account-helpers-BqSrsCej.js";
import { t as resolveAccountEntry } from "./account-lookup-Dr1S5Vra.js";
import { randomBytes, randomUUID } from "node:crypto";

//#region src/signal/accounts.ts
const { listAccountIds, resolveDefaultAccountId } = createAccountListHelpers("signal");
const listSignalAccountIds = listAccountIds;
function resolveAccountConfig(cfg, accountId) {
	return resolveAccountEntry(cfg.channels?.signal?.accounts, accountId);
}
function mergeSignalAccountConfig(cfg, accountId) {
	const { accounts: _ignored, ...base } = cfg.channels?.signal ?? {};
	const account = resolveAccountConfig(cfg, accountId) ?? {};
	return {
		...base,
		...account
	};
}
function resolveSignalAccount(params) {
	const accountId = normalizeAccountId(params.accountId);
	const baseEnabled = params.cfg.channels?.signal?.enabled !== false;
	const merged = mergeSignalAccountConfig(params.cfg, accountId);
	const accountEnabled = merged.enabled !== false;
	const enabled = baseEnabled && accountEnabled;
	const host = merged.httpHost?.trim() || "127.0.0.1";
	const port = merged.httpPort ?? 8080;
	const baseUrl = merged.httpUrl?.trim() || `http://${host}:${port}`;
	const configured = Boolean(merged.account?.trim() || merged.httpUrl?.trim() || merged.cliPath?.trim() || merged.httpHost?.trim() || typeof merged.httpPort === "number" || typeof merged.autoStart === "boolean");
	return {
		accountId,
		enabled,
		name: merged.name?.trim() || void 0,
		baseUrl,
		configured,
		config: merged
	};
}
function listEnabledSignalAccounts(cfg) {
	return listSignalAccountIds(cfg).map((accountId) => resolveSignalAccount({
		cfg,
		accountId
	})).filter((account) => account.enabled);
}

//#endregion
//#region src/utils/reaction-level.ts
const LEVELS = new Set([
	"off",
	"ack",
	"minimal",
	"extensive"
]);
function parseLevel(value) {
	if (value === void 0 || value === null) return { kind: "missing" };
	if (typeof value !== "string") return { kind: "invalid" };
	const trimmed = value.trim();
	if (!trimmed) return { kind: "missing" };
	if (LEVELS.has(trimmed)) return {
		kind: "ok",
		value: trimmed
	};
	return { kind: "invalid" };
}
function resolveReactionLevel(params) {
	const parsed = parseLevel(params.value);
	switch (parsed.kind === "ok" ? parsed.value : parsed.kind === "missing" ? params.defaultLevel : params.invalidFallback) {
		case "off": return {
			level: "off",
			ackEnabled: false,
			agentReactionsEnabled: false
		};
		case "ack": return {
			level: "ack",
			ackEnabled: true,
			agentReactionsEnabled: false
		};
		case "minimal": return {
			level: "minimal",
			ackEnabled: false,
			agentReactionsEnabled: true,
			agentReactionGuidance: "minimal"
		};
		case "extensive": return {
			level: "extensive",
			ackEnabled: false,
			agentReactionsEnabled: true,
			agentReactionGuidance: "extensive"
		};
		default: return {
			level: "minimal",
			ackEnabled: false,
			agentReactionsEnabled: true,
			agentReactionGuidance: "minimal"
		};
	}
}

//#endregion
//#region src/infra/secure-random.ts
function generateSecureUuid() {
	return randomUUID();
}

//#endregion
export { resolveSignalAccount as i, resolveReactionLevel as n, listEnabledSignalAccounts as r, generateSecureUuid as t };