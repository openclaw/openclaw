import { r as theme } from "./theme-CStEj1vt.js";
import { r as writeRuntimeJson } from "./runtime-DDH_zqCr.js";
import { d as markMigrationItemSkipped, g as redactMigrationPlan, v as summarizeMigrationItems } from "./migration-BnsKfCr4.js";
import path from "node:path";
//#region src/commands/migrate/selection.ts
const MIGRATION_SKILL_NOT_SELECTED_REASON = "not selected for migration";
const MIGRATION_PLUGIN_NOT_SELECTED_REASON = "not selected for migration";
const MIGRATION_SELECTION_ACCEPT = "__openclaw_migrate_accept_recommended__";
const MIGRATION_SELECTION_TOGGLE_ALL_ON = "__openclaw_migrate_toggle_all_on__";
const MIGRATION_SELECTION_TOGGLE_ALL_OFF = "__openclaw_migrate_toggle_all_off__";
function normalizeSelectionRef(value) {
	return value.trim().toLowerCase();
}
function readMigrationSkillName(item) {
	const value = item.details?.skillName;
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
function readMigrationSkillSourceLabel(item) {
	const value = item.details?.sourceLabel;
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
function readMigrationPluginName(item) {
	const value = item.details?.pluginName;
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
function readMigrationPluginConfigKey(item) {
	const value = item.details?.configKey;
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
function readMigrationPluginMarketplaceName(item) {
	const value = item.details?.marketplaceName;
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function migrationSkillRefs(item) {
	const skillName = readMigrationSkillName(item);
	const idSuffix = item.id.startsWith("skill:") ? item.id.slice(6) : void 0;
	const sourceBase = item.source ? path.basename(item.source) : void 0;
	const targetBase = item.target ? path.basename(item.target) : void 0;
	return [
		item.id,
		idSuffix,
		skillName,
		sourceBase,
		targetBase
	].filter((value) => typeof value === "string" && value.trim().length > 0);
}
function migrationPluginRefs(item) {
	const pluginName = readMigrationPluginName(item);
	const configKey = readMigrationPluginConfigKey(item);
	const idSuffix = item.id.startsWith("plugin:") ? item.id.slice(7) : void 0;
	const sourceBase = item.source ? path.basename(item.source) : void 0;
	const targetBase = item.target ? path.basename(item.target) : void 0;
	return [
		item.id,
		idSuffix,
		pluginName,
		configKey,
		sourceBase,
		targetBase
	].filter((value) => typeof value === "string" && value.trim().length > 0);
}
function formatSelectionRefList(values) {
	if (values.length === 0) return "none";
	return values.map((value) => `"${value}"`).join(", ");
}
function buildSkillSelectionIndex(items) {
	const index = /* @__PURE__ */ new Map();
	for (const item of items) for (const ref of migrationSkillRefs(item)) {
		const normalized = normalizeSelectionRef(ref);
		if (!normalized) continue;
		const existing = index.get(normalized) ?? /* @__PURE__ */ new Set();
		existing.add(item.id);
		index.set(normalized, existing);
	}
	return index;
}
function buildPluginSelectionIndex(items) {
	const index = /* @__PURE__ */ new Map();
	for (const item of items) for (const ref of migrationPluginRefs(item)) {
		const normalized = normalizeSelectionRef(ref);
		if (!normalized) continue;
		const existing = index.get(normalized) ?? /* @__PURE__ */ new Set();
		existing.add(item.id);
		index.set(normalized, existing);
	}
	return index;
}
function resolveSelectedSkillItemIds(items, selectedRefs) {
	const index = buildSkillSelectionIndex(items);
	const selectedIds = /* @__PURE__ */ new Set();
	const unknownRefs = [];
	const ambiguousRefs = [];
	for (const ref of selectedRefs) {
		const normalized = normalizeSelectionRef(ref);
		if (!normalized) continue;
		const matches = index.get(normalized);
		if (!matches) {
			unknownRefs.push(ref);
			continue;
		}
		if (matches.size > 1) {
			ambiguousRefs.push(ref);
			continue;
		}
		const [id] = matches;
		if (id) selectedIds.add(id);
	}
	if (unknownRefs.length > 0 || ambiguousRefs.length > 0) {
		const available = items.map(formatMigrationSkillSelectionLabel).toSorted((a, b) => a.localeCompare(b));
		const parts = [];
		if (unknownRefs.length > 0) parts.push(`No migratable skill matched ${formatSelectionRefList(unknownRefs)}.`);
		if (ambiguousRefs.length > 0) parts.push(`Skill selection ${formatSelectionRefList(ambiguousRefs)} was ambiguous.`);
		parts.push(`Available skills: ${available.length > 0 ? available.join(", ") : "none"}.`);
		throw new Error(parts.join(" "));
	}
	return selectedIds;
}
function resolveSelectedPluginItemIds(items, selectedRefs) {
	const index = buildPluginSelectionIndex(items);
	const selectedIds = /* @__PURE__ */ new Set();
	const unknownRefs = [];
	const ambiguousRefs = [];
	for (const ref of selectedRefs) {
		const normalized = normalizeSelectionRef(ref);
		if (!normalized) continue;
		const matches = index.get(normalized);
		if (!matches) {
			unknownRefs.push(ref);
			continue;
		}
		if (matches.size > 1) {
			ambiguousRefs.push(ref);
			continue;
		}
		const [id] = matches;
		if (id) selectedIds.add(id);
	}
	if (unknownRefs.length > 0 || ambiguousRefs.length > 0) {
		const available = items.map(formatMigrationPluginSelectionLabel).toSorted((a, b) => a.localeCompare(b));
		const parts = [];
		if (unknownRefs.length > 0) parts.push(`No migratable plugin matched ${formatSelectionRefList(unknownRefs)}.`);
		if (ambiguousRefs.length > 0) parts.push(`Plugin selection ${formatSelectionRefList(ambiguousRefs)} was ambiguous.`);
		parts.push(`Available plugins: ${available.length > 0 ? available.join(", ") : "none"}.`);
		throw new Error(parts.join(" "));
	}
	return selectedIds;
}
function getSelectableMigrationSkillItems(plan) {
	return plan.items.filter((item) => item.kind === "skill" && item.action === "copy" && (item.status === "planned" || item.status === "conflict"));
}
function getSelectableMigrationPluginItems(plan) {
	return plan.items.filter((item) => item.kind === "plugin" && item.action === "install" && (item.status === "planned" || item.status === "conflict"));
}
function getMigrationSkillSelectionValue(item) {
	return item.id;
}
function getMigrationPluginSelectionValue(item) {
	return item.id;
}
function formatMigrationPluginSelectionLabel(item) {
	return readMigrationPluginName(item) ?? item.id.replace(/^plugin:/u, "");
}
function getDefaultMigrationSkillSelectionValues(items) {
	return items.filter((item) => item.status === "planned").map(getMigrationSkillSelectionValue);
}
function getDefaultMigrationPluginSelectionValues(items) {
	return items.filter((item) => item.status === "planned").map(getMigrationPluginSelectionValue);
}
function formatMigrationSkillSelectionLabel(item) {
	return readMigrationSkillName(item) ?? item.id.replace(/^skill:/u, "");
}
function formatMigrationSkillSelectionHint(item) {
	const parts = [readMigrationSkillSourceLabel(item)];
	if (item.status === "conflict") parts.push(item.reason ? `conflict: ${item.reason}` : "conflict");
	return parts.filter((value) => typeof value === "string" && value.length > 0).join("; ") || void 0;
}
function formatMigrationPluginSelectionHint(item) {
	const pluginName = readMigrationPluginName(item);
	const configKey = readMigrationPluginConfigKey(item);
	const parts = [readMigrationPluginMarketplaceName(item), configKey && configKey !== pluginName ? `config: ${configKey}` : void 0];
	if (item.status === "conflict") parts.push(item.reason ? `conflict: ${item.reason}` : "conflict");
	return parts.filter((value) => typeof value === "string" && value.length > 0).join("; ") || void 0;
}
function applyMigrationSelectedSkillItemIds(plan, selectedItemIds) {
	const selectableIds = new Set(getSelectableMigrationSkillItems(plan).map((item) => item.id));
	const items = plan.items.map((item) => {
		if (!selectableIds.has(item.id) || selectedItemIds.has(item.id)) return item;
		return markMigrationItemSkipped(item, MIGRATION_SKILL_NOT_SELECTED_REASON);
	});
	return {
		...plan,
		items,
		summary: summarizeMigrationItems(items)
	};
}
function applyMigrationSkillSelection(plan, selectedSkillRefs) {
	if (selectedSkillRefs === void 0) return plan;
	return applyMigrationSelectedSkillItemIds(plan, resolveSelectedSkillItemIds(getSelectableMigrationSkillItems(plan), selectedSkillRefs));
}
function applyMigrationPluginSelection(plan, selectedPluginRefs) {
	if (selectedPluginRefs === void 0) return plan;
	return applyMigrationSelectedPluginItemIds(plan, resolveSelectedPluginItemIds(getSelectableMigrationPluginItems(plan), selectedPluginRefs));
}
function applyMigrationSelectedPluginItemIds(plan, selectedItemIds) {
	const selectable = getSelectableMigrationPluginItems(plan);
	const selectableIds = new Set(selectable.map((item) => item.id));
	const selectedConfigKeys = new Set(selectable.filter((item) => selectedItemIds.has(item.id)).map(readMigrationPluginConfigKey).filter((value) => value !== void 0));
	const items = plan.items.map((item) => {
		if (isCodexPluginConfigItem(item)) return applyCodexPluginConfigSelection(item, selectedConfigKeys);
		if (!selectableIds.has(item.id) || selectedItemIds.has(item.id)) return item;
		return markMigrationItemSkipped(item, MIGRATION_PLUGIN_NOT_SELECTED_REASON);
	});
	return {
		...plan,
		items,
		summary: summarizeMigrationItems(items)
	};
}
function isCodexPluginConfigItem(item) {
	if (item.kind !== "config" || item.action !== "merge") return false;
	const value = item.details?.value;
	if (!isRecord(value)) return false;
	const config = value.config;
	if (!isRecord(config)) return false;
	const codexPlugins = config.codexPlugins;
	if (!isRecord(codexPlugins)) return false;
	return isRecord(codexPlugins.plugins);
}
function applyCodexPluginConfigSelection(item, selectedConfigKeys) {
	const value = item.details?.value;
	if (!isRecord(value)) return item;
	const config = value.config;
	if (!isRecord(config)) return item;
	const codexPlugins = config.codexPlugins;
	if (!isRecord(codexPlugins) || !isRecord(codexPlugins.plugins)) return item;
	const plugins = Object.fromEntries(Object.entries(codexPlugins.plugins).filter(([configKey]) => selectedConfigKeys.has(configKey)));
	if (Object.keys(plugins).length === 0) return markMigrationItemSkipped(item, MIGRATION_PLUGIN_NOT_SELECTED_REASON);
	return {
		...item,
		details: {
			...item.details,
			value: {
				...value,
				config: {
					...config,
					codexPlugins: {
						...codexPlugins,
						plugins
					}
				}
			}
		}
	};
}
function resolveInteractiveMigrationSelection(items, selectedValues, getSelectionValue) {
	const selectableIds = new Set(items.map(getSelectionValue));
	const selectedItemIds = new Set(selectedValues.filter((value) => selectableIds.has(value)));
	if (selectedItemIds.size > 0) return {
		action: "select",
		selectedItemIds
	};
	const selectedValueSet = new Set(selectedValues);
	if (selectedValueSet.has("__openclaw_migrate_toggle_all_off__")) return {
		action: "select",
		selectedItemIds: /* @__PURE__ */ new Set()
	};
	if (selectedValueSet.has("__openclaw_migrate_toggle_all_on__")) return {
		action: "select",
		selectedItemIds: selectableIds
	};
	return {
		action: "select",
		selectedItemIds
	};
}
function resolveInteractiveMigrationSkillSelection(items, selectedValues) {
	return resolveInteractiveMigrationSelection(items, selectedValues, getMigrationSkillSelectionValue);
}
function resolveInteractiveMigrationPluginSelection(items, selectedValues) {
	return resolveInteractiveMigrationSelection(items, selectedValues, getMigrationPluginSelectionValue);
}
function reconcileInteractiveMigrationSkillToggleValues(selectedValues, activatedValue, selectableValues) {
	if (activatedValue === "__openclaw_migrate_toggle_all_on__") return [MIGRATION_SELECTION_TOGGLE_ALL_ON, ...selectableValues];
	if (activatedValue === "__openclaw_migrate_toggle_all_off__") return [MIGRATION_SELECTION_TOGGLE_ALL_OFF];
	if (activatedValue !== void 0 && selectableValues.includes(activatedValue)) return selectedValues.filter((value) => value !== "__openclaw_migrate_toggle_all_on__" && value !== "__openclaw_migrate_toggle_all_off__");
	return selectedValues.filter((value) => value !== "__openclaw_migrate_toggle_all_on__" || !selectedValues.includes("__openclaw_migrate_toggle_all_off__"));
}
function reconcileInteractiveMigrationEnterValues(selectedValues, activatedValue, selectableValues, opts = {}) {
	if (activatedValue === "__openclaw_migrate_toggle_all_on__") return [MIGRATION_SELECTION_TOGGLE_ALL_ON, ...selectableValues];
	if (activatedValue === "__openclaw_migrate_toggle_all_off__") return [MIGRATION_SELECTION_TOGGLE_ALL_OFF];
	if (activatedValue !== void 0 && selectableValues.includes(activatedValue)) {
		const selectedSelectableValues = selectedValues.filter((value) => value !== "__openclaw_migrate_toggle_all_on__" && value !== "__openclaw_migrate_toggle_all_off__");
		if (opts.preserveDeselectedActivatedValue && !selectedValues.includes(activatedValue)) return selectedSelectableValues;
		return Array.from(new Set([...selectedSelectableValues, activatedValue]));
	}
	return [...selectedValues];
}
function reconcileInteractiveMigrationShortcutValues(previousValues, selectedValues, selectableValues, key) {
	const previousSelectable = previousValues.filter((value) => selectableValues.includes(value));
	if (key === "a" && previousSelectable.length === selectableValues.length) return [MIGRATION_SELECTION_TOGGLE_ALL_OFF];
	const selectedSelectable = selectedValues.filter((value) => selectableValues.includes(value));
	if (selectedSelectable.length === selectableValues.length) return [MIGRATION_SELECTION_TOGGLE_ALL_ON, ...selectableValues];
	if (selectedSelectable.length === 0) return [MIGRATION_SELECTION_TOGGLE_ALL_OFF];
	return selectedSelectable;
}
//#endregion
//#region src/commands/migrate/output.ts
function formatCount(value, label) {
	return `${value} ${label}${value === 1 ? "" : "s"}`;
}
function formatMigrationPlan(plan) {
	const lines = [`${theme.heading("Migration plan:")} ${plan.providerId}`, `Source: ${plan.source}`];
	if (plan.target) lines.push(`Target: ${plan.target}`);
	lines.push([
		formatCount(plan.summary.total, "item"),
		formatCount(plan.summary.conflicts, "conflict"),
		formatCount(plan.summary.sensitive, "sensitive item")
	].join(", "));
	if (plan.warnings && plan.warnings.length > 0) {
		lines.push("");
		lines.push(theme.warn("Warnings:"));
		for (const warning of plan.warnings) lines.push(`- ${warning}`);
	}
	const visibleItems = plan.items.slice(0, 25);
	const visibleItemIds = new Set(visibleItems.map((item) => item.id));
	const pluginItems = getSelectableMigrationPluginItems(plan);
	const hasPluginHiddenByTruncation = pluginItems.some((item) => !visibleItemIds.has(item.id));
	if (plan.providerId === "codex" && hasPluginHiddenByTruncation) {
		lines.push("");
		lines.push(theme.heading("Native Codex plugins:"));
		for (const item of pluginItems) lines.push(`- ${formatMigrationPluginSelectionLabel(item)}`);
	}
	if (visibleItems.length > 0) {
		lines.push("");
		lines.push(theme.heading("Items:"));
		for (const item of visibleItems) lines.push(formatMigrationItem(item));
		if (plan.items.length > visibleItems.length) lines.push(`- ... ${plan.items.length - visibleItems.length} more`);
	}
	if (plan.nextSteps && plan.nextSteps.length > 0) {
		lines.push("");
		lines.push(theme.heading("Next:"));
		for (const step of plan.nextSteps) lines.push(`- ${step}`);
	}
	return lines;
}
function formatMigrationItem(item) {
	const target = item.target ? ` -> ${item.target}` : "";
	const message = item.message ? ` (${item.message})` : item.reason ? ` (${item.reason})` : "";
	const sensitive = item.sensitive ? " [sensitive]" : "";
	return `- ${item.status}: ${item.kind}/${item.action} ${item.id}${target}${sensitive}${message}`;
}
function assertConflictFreePlan(plan, providerId) {
	if (plan.summary.conflicts > 0) throw new Error(`Migration has ${formatCount(plan.summary.conflicts, "conflict")}. Re-run with --overwrite after reviewing openclaw migrate plan ${providerId}.`);
}
function writeApplyResult(runtime, opts, result) {
	if (opts.json) {
		writeRuntimeJson(runtime, redactMigrationPlan(result));
		return;
	}
	runtime.log(formatMigrationPlan(result).join("\n"));
	if (result.backupPath) runtime.log(`Backup: ${result.backupPath}`);
	else if (!opts.noBackup) runtime.log("Backup: skipped (no existing OpenClaw state found)");
	if (result.reportDir) runtime.log(`Report: ${result.reportDir}`);
}
function assertApplySucceeded(result) {
	if (result.summary.errors === 0 && result.summary.conflicts === 0) return;
	const reportHint = result.reportDir ? ` See report: ${result.reportDir}.` : "";
	if (result.summary.errors > 0) throw new Error(`Migration finished with ${formatCount(result.summary.errors, "error")}.${reportHint}`);
	throw new Error(`Migration finished with ${formatCount(result.summary.conflicts, "conflict")}.${reportHint}`);
}
//#endregion
export { reconcileInteractiveMigrationShortcutValues as C, resolveInteractiveMigrationSkillSelection as E, reconcileInteractiveMigrationEnterValues as S, resolveInteractiveMigrationPluginSelection as T, getDefaultMigrationSkillSelectionValues as _, MIGRATION_SELECTION_ACCEPT as a, getSelectableMigrationPluginItems as b, applyMigrationPluginSelection as c, applyMigrationSkillSelection as d, formatMigrationPluginSelectionHint as f, getDefaultMigrationPluginSelectionValues as g, formatMigrationSkillSelectionLabel as h, writeApplyResult as i, applyMigrationSelectedPluginItemIds as l, formatMigrationSkillSelectionHint as m, assertConflictFreePlan as n, MIGRATION_SELECTION_TOGGLE_ALL_OFF as o, formatMigrationPluginSelectionLabel as p, formatMigrationPlan as r, MIGRATION_SELECTION_TOGGLE_ALL_ON as s, assertApplySucceeded as t, applyMigrationSelectedSkillItemIds as u, getMigrationPluginSelectionValue as v, reconcileInteractiveMigrationSkillToggleValues as w, getSelectableMigrationSkillItems as x, getMigrationSkillSelectionValue as y };
