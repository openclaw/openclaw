import { c as isRecord } from "./utils-CRkrr5e6.js";
import "./string-coerce-runtime-Eud5uIH2.js";
//#region extensions/amazon-bedrock/config-compat.ts
const LEGACY_PATH = "models.bedrockDiscovery";
const TARGET_PATH = "plugins.entries.amazon-bedrock.config.discovery";
const BLOCKED_OBJECT_KEYS = new Set([
	"__proto__",
	"prototype",
	"constructor"
]);
function isBlockedObjectKey(key) {
	return BLOCKED_OBJECT_KEYS.has(key);
}
function getRecord(value) {
	return isRecord(value) ? value : null;
}
function ensureRecord(root, key) {
	const existing = root[key];
	if (isRecord(existing)) return existing;
	const next = {};
	root[key] = next;
	return next;
}
function mergeMissing(target, source) {
	for (const [key, value] of Object.entries(source)) {
		if (value === void 0 || isBlockedObjectKey(key)) continue;
		const existing = target[key];
		if (existing === void 0) {
			target[key] = value;
			continue;
		}
		if (isRecord(existing) && isRecord(value)) mergeMissing(existing, value);
	}
}
function cloneRecord(value) {
	return { ...value };
}
function resolveLegacyBedrockDiscoveryConfig(raw) {
	if (!isRecord(raw)) return;
	return getRecord(getRecord(raw.models)?.bedrockDiscovery) ?? void 0;
}
function pruneEmptyModelsRoot(root) {
	const models = getRecord(root.models);
	if (models && Object.keys(models).length === 0) delete root.models;
}
function migrateAmazonBedrockLegacyConfig(raw) {
	if (!isRecord(raw)) return {
		config: raw,
		changes: []
	};
	const legacy = resolveLegacyBedrockDiscoveryConfig(raw);
	if (!legacy) return {
		config: raw,
		changes: []
	};
	const nextRoot = structuredClone(raw);
	const models = ensureRecord(nextRoot, "models");
	delete models.bedrockDiscovery;
	pruneEmptyModelsRoot(nextRoot);
	const changes = [];
	if (Object.keys(legacy).length === 0) {
		changes.push(`Removed empty ${LEGACY_PATH}.`);
		return {
			config: nextRoot,
			changes
		};
	}
	const config = ensureRecord(ensureRecord(ensureRecord(ensureRecord(nextRoot, "plugins"), "entries"), "amazon-bedrock"), "config");
	const existing = getRecord(config.discovery) ?? void 0;
	if (!existing) {
		config.discovery = cloneRecord(legacy);
		changes.push(`Moved ${LEGACY_PATH} → ${TARGET_PATH}.`);
		return {
			config: nextRoot,
			changes
		};
	}
	const merged = cloneRecord(existing);
	mergeMissing(merged, legacy);
	config.discovery = merged;
	if (JSON.stringify(merged) !== JSON.stringify(existing)) {
		changes.push(`Merged ${LEGACY_PATH} → ${TARGET_PATH} (filled missing fields from legacy; kept explicit plugin config values).`);
		return {
			config: nextRoot,
			changes
		};
	}
	changes.push(`Removed ${LEGACY_PATH} (${TARGET_PATH} already set).`);
	return {
		config: nextRoot,
		changes
	};
}
//#endregion
export { migrateAmazonBedrockLegacyConfig as t };
