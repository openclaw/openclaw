import { y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import "./config-B6Oplu5W.js";
import { r as withProgress } from "./progress-CE2g1zbv.js";
import { d as markMigrationItemSkipped, v as summarizeMigrationItems } from "./migration-DGUrqTK8.js";
import { t as backupCreateCommand } from "./backup-D1De6xVr.js";
import { n as resolvePluginMigrationProvider, r as resolvePluginMigrationProviders, t as ensureStandaloneMigrationProviderRegistryLoaded } from "./migration-provider-runtime-Bf3l4KBj.js";
import { n as buildMigrationReportDir, t as buildMigrationContext } from "./context-Ck6pPYyR.js";
import { n as assertApplySucceeded, o as writeApplyResult, r as assertConflictFreePlan, t as MIGRATION_CONFLICT_REASON_PHRASES } from "./output-DSK0bfK1.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region src/commands/migrate/providers.ts
function resolveMigrationProvider(providerId, config = getRuntimeConfig()) {
	ensureStandaloneMigrationProviderRegistryLoaded({ cfg: config });
	const provider = resolvePluginMigrationProvider({
		providerId,
		cfg: config
	});
	if (!provider) {
		const available = resolvePluginMigrationProviders({ cfg: config }).map((entry) => entry.id);
		const suffix = available.length > 0 ? ` Available providers: ${available.join(", ")}.` : " No providers found.";
		throw new Error(`Unknown migration provider "${providerId}".${suffix}`);
	}
	return provider;
}
function buildMigrationProviderOptions(opts, providerId = opts.provider) {
	const options = {};
	if (providerId === "codex" && opts.verifyPluginApps === true) options.verifyPluginApps = true;
	if (providerId === "codex" && opts.configPatchMode) options.configPatchMode = opts.configPatchMode;
	return Object.keys(options).length > 0 ? options : void 0;
}
async function createMigrationPlan(runtime, opts) {
	if (opts.verifyPluginApps && opts.provider !== "codex") throw new Error("--verify-plugin-apps is only supported for Codex migrations.");
	const provider = resolveMigrationProvider(opts.provider, opts.configOverride);
	const ctx = buildMigrationContext({
		source: opts.source,
		includeSecrets: opts.includeSecrets,
		overwrite: opts.overwrite,
		configOverride: opts.configOverride,
		providerOptions: buildMigrationProviderOptions(opts),
		runtime,
		json: opts.json
	});
	return await provider.plan(ctx);
}
//#endregion
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
function humanizeMigrationConflictReason(reason) {
	if (!reason) return "conflict";
	return MIGRATION_CONFLICT_REASON_PHRASES[reason] ?? reason;
}
function formatMigrationSkillSelectionHint(item) {
	if (item.status !== "conflict") return;
	const sourceLabel = readMigrationSkillSourceLabel(item);
	const reason = humanizeMigrationConflictReason(item.reason);
	return sourceLabel ? `${sourceLabel} ${reason}` : reason;
}
function formatMigrationPluginSelectionHint(item) {
	if (item.status !== "conflict") return;
	const marketplace = readMigrationPluginMarketplaceName(item);
	const reason = humanizeMigrationConflictReason(item.reason);
	return marketplace ? `${marketplace} plugin ${reason}` : reason;
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
//#region src/commands/migrate/apply.ts
function shouldTreatMissingBackupAsEmptyState(error) {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("No local OpenClaw state was found to back up") || message.includes("No OpenClaw config file was found to back up");
}
async function createPreMigrationBackup(opts) {
	try {
		return (await backupCreateCommand({
			log() {},
			error() {},
			exit(code) {
				throw new Error(`backup exited with ${code}`);
			}
		}, {
			output: opts.output,
			verify: true
		})).archivePath;
	} catch (err) {
		if (shouldTreatMissingBackupAsEmptyState(err)) return;
		throw err;
	}
}
async function runMigrationApply(params) {
	const applyMigration = async (progress) => {
		const total = (params.opts.preflightPlan ? 0 : 1) + (params.opts.noBackup ? 0 : 1) + 1;
		let completed = 0;
		const tick = () => {
			completed += 1;
			progress?.setPercent(completed / total * 100);
		};
		if (!params.opts.preflightPlan) progress?.setLabel("Preparing migration plan…");
		const preflightPlan = params.opts.preflightPlan ?? await params.provider.plan(buildMigrationContext({
			source: params.opts.source,
			includeSecrets: params.opts.includeSecrets,
			overwrite: params.opts.overwrite,
			configOverride: params.opts.configOverride,
			providerOptions: buildMigrationProviderOptions(params.opts, params.providerId),
			runtime: params.runtime,
			json: params.opts.json
		}));
		if (!params.opts.preflightPlan) tick();
		const selectedPlan = applyMigrationPluginSelection(applyMigrationSkillSelection(preflightPlan, params.opts.skills), params.opts.plugins);
		assertConflictFreePlan(selectedPlan, params.providerId);
		const stateDir = resolveStateDir();
		const reportDir = buildMigrationReportDir(params.providerId, stateDir);
		if (!params.opts.noBackup) progress?.setLabel("Preparing migration backup…");
		const backupPath = params.opts.noBackup ? void 0 : await createPreMigrationBackup({ output: params.opts.backupOutput });
		if (!params.opts.noBackup) tick();
		await fs.mkdir(reportDir, { recursive: true });
		const ctx = buildMigrationContext({
			source: params.opts.source,
			includeSecrets: params.opts.includeSecrets,
			overwrite: params.opts.overwrite,
			configOverride: params.opts.configOverride,
			providerOptions: buildMigrationProviderOptions(params.opts, params.providerId),
			runtime: params.runtime,
			backupPath,
			reportDir,
			json: params.opts.json
		});
		progress?.setLabel("Applying migration…");
		const result = await params.provider.apply(ctx, selectedPlan);
		tick();
		return {
			...result,
			backupPath: result.backupPath ?? backupPath,
			reportDir: result.reportDir ?? reportDir
		};
	};
	const withBackup = params.opts.json ? await applyMigration() : await withProgress({ label: `Applying ${params.providerId} migration…` }, async (progress) => await applyMigration(progress));
	writeApplyResult(params.runtime, params.opts, withBackup);
	assertApplySucceeded(withBackup);
	return withBackup;
}
//#endregion
export { resolveInteractiveMigrationPluginSelection as C, resolveMigrationProvider as E, reconcileInteractiveMigrationSkillToggleValues as S, createMigrationPlan as T, getMigrationSkillSelectionValue as _, MIGRATION_SELECTION_TOGGLE_ALL_ON as a, reconcileInteractiveMigrationEnterValues as b, applyMigrationSelectedSkillItemIds as c, formatMigrationPluginSelectionLabel as d, formatMigrationSkillSelectionHint as f, getMigrationPluginSelectionValue as g, getDefaultMigrationSkillSelectionValues as h, MIGRATION_SELECTION_TOGGLE_ALL_OFF as i, applyMigrationSkillSelection as l, getDefaultMigrationPluginSelectionValues as m, runMigrationApply as n, applyMigrationPluginSelection as o, formatMigrationSkillSelectionLabel as p, MIGRATION_SELECTION_ACCEPT as r, applyMigrationSelectedPluginItemIds as s, createPreMigrationBackup as t, formatMigrationPluginSelectionHint as u, getSelectableMigrationPluginItems as v, resolveInteractiveMigrationSkillSelection as w, reconcileInteractiveMigrationShortcutValues as x, getSelectableMigrationSkillItems as y };
