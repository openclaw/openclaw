//#region src/plugin-sdk/migration.ts
const MIGRATION_REASON_MISSING_SOURCE_OR_TARGET = "missing source or target";
const MIGRATION_REASON_TARGET_EXISTS = "target exists";
function createMigrationItem(params) {
	return {
		...params,
		status: params.status ?? "planned"
	};
}
function markMigrationItemConflict(item, reason) {
	return {
		...item,
		status: "conflict",
		reason
	};
}
function markMigrationItemError(item, reason) {
	return {
		...item,
		status: "error",
		reason
	};
}
function markMigrationItemSkipped(item, reason) {
	return {
		...item,
		status: "skipped",
		reason
	};
}
function summarizeMigrationItems(items) {
	return {
		total: items.length,
		planned: items.filter((item) => item.status === "planned").length,
		migrated: items.filter((item) => item.status === "migrated").length,
		skipped: items.filter((item) => item.status === "skipped").length,
		conflicts: items.filter((item) => item.status === "conflict").length,
		errors: items.filter((item) => item.status === "error").length,
		sensitive: items.filter((item) => item.sensitive).length
	};
}
const REDACTED_MIGRATION_VALUE = "[redacted]";
const SECRET_KEY_MARKERS = [
	"accesstoken",
	"apikey",
	"authorization",
	"bearertoken",
	"clientsecret",
	"cookie",
	"credential",
	"password",
	"privatekey",
	"refreshtoken",
	"secret"
];
const SECRET_VALUE_PATTERNS = [
	/\bBearer\s+[A-Za-z0-9._~+/=-]+/gu,
	/\bsk-[A-Za-z0-9_-]{8,}\b/gu,
	/\bgh[pousr]_[A-Za-z0-9_]{16,}\b/gu,
	/\bxox[abprs]-[A-Za-z0-9-]{8,}\b/gu,
	/\bAIza[0-9A-Za-z_-]{12,}\b/gu
];
function normalizeSecretKey(key) {
	return key.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
}
function isSecretKey(key) {
	const normalized = normalizeSecretKey(key);
	if (normalized === "token" || normalized.endsWith("token")) return true;
	if (normalized === "auth" || normalized === "authorization") return true;
	return SECRET_KEY_MARKERS.some((marker) => normalized.includes(marker));
}
function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
var MigrationConfigPatchConflictError = class extends Error {
	constructor(reason) {
		super(reason);
		this.reason = reason;
		this.name = "MigrationConfigPatchConflictError";
	}
};
function readMigrationConfigPath(root, path) {
	let current = root;
	for (const segment of path) {
		if (!isRecord(current)) return;
		current = current[segment];
	}
	return current;
}
function mergeMigrationConfigValue(left, right) {
	if (!isRecord(left) || !isRecord(right)) return structuredClone(right);
	const next = { ...left };
	for (const [key, value] of Object.entries(right)) next[key] = mergeMigrationConfigValue(next[key], value);
	return next;
}
function writeMigrationConfigPath(root, path, value) {
	let current = root;
	for (const segment of path.slice(0, -1)) {
		const existing = current[segment];
		if (!isRecord(existing)) current[segment] = {};
		current = current[segment];
	}
	const leaf = path.at(-1);
	if (!leaf) return;
	current[leaf] = mergeMigrationConfigValue(current[leaf], value);
}
function hasMigrationConfigPatchConflict(config, path, value) {
	if (!isRecord(value)) return readMigrationConfigPath(config, path) !== void 0;
	const existing = readMigrationConfigPath(config, path);
	if (!isRecord(existing)) return false;
	return Object.keys(value).some((key) => existing[key] !== void 0);
}
function createMigrationConfigPatchItem(params) {
	return createMigrationItem({
		id: params.id,
		kind: "config",
		action: "merge",
		source: params.source,
		target: params.target,
		status: params.conflict ? "conflict" : "planned",
		reason: params.conflict ? params.reason ?? "target exists" : void 0,
		message: params.message,
		details: {
			...params.details,
			path: params.path,
			value: params.value
		}
	});
}
function createMigrationManualItem(params) {
	return createMigrationItem({
		id: params.id,
		kind: "manual",
		action: "manual",
		source: params.source,
		status: "skipped",
		message: params.message,
		reason: params.recommendation
	});
}
function readMigrationConfigPatchDetails(item) {
	const path = item.details?.path;
	if (!Array.isArray(path) || !path.every((segment) => typeof segment === "string")) return;
	return {
		path,
		value: item.details?.value
	};
}
async function applyMigrationConfigPatchItem(ctx, item) {
	if (item.status !== "planned") return item;
	const details = readMigrationConfigPatchDetails(item);
	if (!details) return markMigrationItemError(item, "missing config patch");
	const configApi = ctx.runtime?.config;
	if (!configApi?.current || !configApi.mutateConfigFile) return markMigrationItemError(item, "config runtime unavailable");
	try {
		const currentConfig = configApi.current();
		if (!ctx.overwrite && hasMigrationConfigPatchConflict(currentConfig, details.path, details.value)) return markMigrationItemConflict(item, MIGRATION_REASON_TARGET_EXISTS);
		await configApi.mutateConfigFile({
			base: "runtime",
			afterWrite: { mode: "auto" },
			mutate(draft) {
				if (!ctx.overwrite && hasMigrationConfigPatchConflict(draft, details.path, details.value)) throw new MigrationConfigPatchConflictError(MIGRATION_REASON_TARGET_EXISTS);
				writeMigrationConfigPath(draft, details.path, details.value);
			}
		});
		return {
			...item,
			status: "migrated"
		};
	} catch (err) {
		if (err instanceof MigrationConfigPatchConflictError) return markMigrationItemConflict(item, err.reason);
		return markMigrationItemError(item, err instanceof Error ? err.message : String(err));
	}
}
function applyMigrationManualItem(item) {
	return markMigrationItemSkipped(item, item.reason ?? "manual follow-up required");
}
function isSecretReferenceLike(value) {
	if (!isRecord(value)) return false;
	return value.source === "env" && typeof value.id === "string" && (value.provider === void 0 || typeof value.provider === "string");
}
function redactString(value) {
	let next = value;
	for (const pattern of SECRET_VALUE_PATTERNS) next = next.replace(pattern, REDACTED_MIGRATION_VALUE);
	return next;
}
function redactMigrationValueInternal(value, seen) {
	if (typeof value === "string") return redactString(value);
	if (Array.isArray(value)) return value.map((entry) => redactMigrationValueInternal(entry, seen));
	if (!value || typeof value !== "object") return value;
	if (seen.has(value)) return REDACTED_MIGRATION_VALUE;
	seen.add(value);
	const next = {};
	for (const [key, entry] of Object.entries(value)) {
		if (isSecretKey(key) && !isSecretReferenceLike(entry)) {
			next[key] = REDACTED_MIGRATION_VALUE;
			continue;
		}
		next[key] = redactMigrationValueInternal(entry, seen);
	}
	return next;
}
function redactMigrationValue(value) {
	return redactMigrationValueInternal(value, /* @__PURE__ */ new WeakSet());
}
function redactMigrationItem(item) {
	return redactMigrationValue(item);
}
function redactMigrationPlan(plan) {
	return redactMigrationValue(plan);
}
//#endregion
export { redactMigrationValue as _, createMigrationConfigPatchItem as a, hasMigrationConfigPatchConflict as c, markMigrationItemSkipped as d, mergeMigrationConfigValue as f, redactMigrationPlan as g, redactMigrationItem as h, applyMigrationManualItem as i, markMigrationItemConflict as l, readMigrationConfigPath as m, MIGRATION_REASON_TARGET_EXISTS as n, createMigrationItem as o, readMigrationConfigPatchDetails as p, applyMigrationConfigPatchItem as r, createMigrationManualItem as s, MIGRATION_REASON_MISSING_SOURCE_OR_TARGET as t, markMigrationItemError as u, summarizeMigrationItems as v, writeMigrationConfigPath as y };
