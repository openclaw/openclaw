import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { r as writeRuntimeJson } from "./runtime-yzlkhCoS.js";
import { n as promptYesNo } from "./prompt-BsiHocog.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import "./config-B6Oplu5W.js";
import { r as withProgress } from "./progress-CE2g1zbv.js";
import { n as stylePromptMessage, r as stylePromptTitle, t as stylePromptHint } from "./prompt-style-DH7LpiPN.js";
import { g as redactMigrationPlan } from "./migration-DGUrqTK8.js";
import { r as resolvePluginMigrationProviders, t as ensureStandaloneMigrationProviderRegistryLoaded } from "./migration-provider-runtime-Bf3l4KBj.js";
import { i as formatMigrationPreview } from "./output-DSK0bfK1.js";
import { C as resolveInteractiveMigrationPluginSelection, E as resolveMigrationProvider, S as reconcileInteractiveMigrationSkillToggleValues, T as createMigrationPlan, _ as getMigrationSkillSelectionValue, a as MIGRATION_SELECTION_TOGGLE_ALL_ON, b as reconcileInteractiveMigrationEnterValues, c as applyMigrationSelectedSkillItemIds, d as formatMigrationPluginSelectionLabel, f as formatMigrationSkillSelectionHint, g as getMigrationPluginSelectionValue, h as getDefaultMigrationSkillSelectionValues, i as MIGRATION_SELECTION_TOGGLE_ALL_OFF, l as applyMigrationSkillSelection, m as getDefaultMigrationPluginSelectionValues, n as runMigrationApply, o as applyMigrationPluginSelection, p as formatMigrationSkillSelectionLabel, r as MIGRATION_SELECTION_ACCEPT, s as applyMigrationSelectedPluginItemIds, u as formatMigrationPluginSelectionHint, v as getSelectableMigrationPluginItems, w as resolveInteractiveMigrationSkillSelection, x as reconcileInteractiveMigrationShortcutValues, y as getSelectableMigrationSkillItems } from "./apply-CDBjgG9O.js";
import { styleText } from "node:util";
import { S_BAR, S_BAR_END, S_CHECKBOX_ACTIVE, S_CHECKBOX_INACTIVE, S_CHECKBOX_SELECTED, cancel, isCancel, limitOptions, log, symbol, symbolBar } from "@clack/prompts";
import { MultiSelectPrompt, settings, wrapTextWithPrefix } from "@clack/core";
//#region src/commands/migrate/skill-selection-prompt.ts
function formatOption(option, state) {
	const label = option.label ?? option.value;
	const withHint = option.hint ? `${label} ${styleText("dim", `(${option.hint})`)}` : label;
	switch (state) {
		case "active": return `${styleText("cyan", S_CHECKBOX_ACTIVE)} ${withHint}`;
		case "active-selected": return `${styleText("green", S_CHECKBOX_SELECTED)} ${withHint}`;
		case "cancelled": return styleText(["strikethrough", "dim"], label);
		case "disabled": return `${styleText("gray", S_CHECKBOX_INACTIVE)} ${styleText(["strikethrough", "gray"], label)}${option.hint ? ` ${styleText("dim", `(${option.hint})`)}` : ""}`;
		case "selected": return `${styleText("green", S_CHECKBOX_SELECTED)} ${styleText("dim", withHint)}`;
		case "submitted": return styleText("dim", label);
		case "inactive": return `${styleText("dim", S_CHECKBOX_INACTIVE)} ${styleText("dim", withHint)}`;
	}
	return withHint;
}
function promptMigrationSkillSelectionValues(opts) {
	const required = opts.required ?? true;
	const prompt = new MultiSelectPrompt({
		options: opts.options,
		signal: opts.signal,
		input: opts.input,
		output: opts.output,
		initialValues: opts.initialValues,
		required,
		cursorAt: opts.cursorAt,
		validate(value) {
			if (required && (value === void 0 || value.length === 0)) return "Please select at least one option.";
		},
		render() {
			const withGuide = opts.withGuide ?? settings.withGuide;
			const message = wrapTextWithPrefix(opts.output, opts.message, withGuide ? `${symbolBar(this.state)}  ` : "", `${symbol(this.state)}  `);
			const header = `${withGuide ? `${styleText("gray", S_BAR)}\n` : ""}${message}\n`;
			const value = this.value ?? [];
			const optionState = (option, active) => {
				if (option.disabled) return formatOption(option, "disabled");
				const selected = value.includes(option.value);
				if (active && selected) return formatOption(option, "active-selected");
				if (selected) return formatOption(option, "selected");
				return formatOption(option, active ? "active" : "inactive");
			};
			switch (this.state) {
				case "submit": {
					const label = this.options.filter((option) => value.includes(option.value)).map((option) => formatOption(option, "submitted")).join(styleText("dim", ", ")) || styleText("dim", "none");
					return `${header}${wrapTextWithPrefix(opts.output, label, withGuide ? `${styleText("gray", S_BAR)}  ` : "")}`;
				}
				case "cancel": {
					const selected = this.options.filter((option) => value.includes(option.value)).map((option) => formatOption(option, "cancelled")).join(styleText("dim", ", "));
					if (selected.trim() === "") return `${header}${styleText("gray", S_BAR)}`;
					return `${header}${wrapTextWithPrefix(opts.output, selected, withGuide ? `${styleText("gray", S_BAR)}  ` : "")}${withGuide ? `\n${styleText("gray", S_BAR)}` : ""}`;
				}
				case "error": {
					const prefix = withGuide ? `${styleText("yellow", S_BAR)}  ` : "";
					return `${header}${prefix}${limitOptions({
						output: opts.output,
						options: this.options,
						cursor: this.cursor,
						maxItems: opts.maxItems,
						columnPadding: prefix.length,
						rowPadding: header.split("\n").length + this.error.split("\n").length + 1,
						style: optionState
					}).join(`\n${prefix}`)}\n${this.error.split("\n").map((line, index) => index === 0 ? `${withGuide ? `${styleText("yellow", S_BAR_END)}  ` : ""}${styleText("yellow", line)}` : `   ${line}`).join("\n")}\n`;
				}
				default: {
					const prefix = withGuide ? `${styleText("cyan", S_BAR)}  ` : "";
					return `${header}${prefix}${limitOptions({
						output: opts.output,
						options: this.options,
						cursor: this.cursor,
						maxItems: opts.maxItems,
						columnPadding: prefix.length,
						rowPadding: header.split("\n").length + (withGuide ? 2 : 1),
						style: optionState
					}).join(`\n${prefix}`)}\n${withGuide ? styleText("cyan", S_BAR_END) : ""}\n`;
				}
			}
		}
	});
	let lastSelectedValues = [...prompt.value ?? []];
	let lastSpaceDeselectedValue;
	prompt.on("cursor", (key) => {
		if (key !== "space") {
			lastSpaceDeselectedValue = void 0;
			return;
		}
		const activatedValue = prompt.options[prompt.cursor]?.value;
		if (activatedValue === "__openclaw_migrate_accept_recommended__") {
			prompt.value = [...opts.initialValues ?? []];
			lastSpaceDeselectedValue = void 0;
			lastSelectedValues = [...prompt.value ?? []];
			return;
		}
		const previousValues = lastSelectedValues;
		prompt.value = reconcileInteractiveMigrationSkillToggleValues(prompt.value ?? [], activatedValue, opts.selectableValues);
		lastSpaceDeselectedValue = activatedValue !== void 0 && opts.selectableValues.includes(activatedValue) && previousValues.includes(activatedValue) && !(prompt.value ?? []).includes(activatedValue) ? activatedValue : void 0;
		lastSelectedValues = [...prompt.value ?? []];
	});
	prompt.on("key", (key, info) => {
		if (info.name === "return") {
			const activatedOption = prompt.options[prompt.cursor];
			const activatedValue = activatedOption?.disabled ? void 0 : activatedOption?.value;
			if (activatedValue === "__openclaw_migrate_accept_recommended__") {
				prompt.value = [...opts.initialValues ?? []];
				lastSpaceDeselectedValue = void 0;
				lastSelectedValues = [...prompt.value ?? []];
				return;
			}
			prompt.value = reconcileInteractiveMigrationEnterValues(prompt.value ?? [], activatedValue, opts.selectableValues, { preserveDeselectedActivatedValue: activatedValue !== void 0 && activatedValue === lastSpaceDeselectedValue && !(prompt.value ?? []).includes(activatedValue) });
			lastSpaceDeselectedValue = void 0;
			lastSelectedValues = [...prompt.value ?? []];
			return;
		}
		if (key !== "a" && key !== "i") return;
		prompt.value = reconcileInteractiveMigrationShortcutValues(lastSelectedValues, prompt.value ?? [], opts.selectableValues, key);
		lastSpaceDeselectedValue = void 0;
		lastSelectedValues = [...prompt.value ?? []];
	});
	return prompt.prompt();
}
const promptMigrationSelectionValues = promptMigrationSkillSelectionValues;
//#endregion
//#region src/commands/migrate.ts
function selectMigrationItems(plan, opts) {
	return applyMigrationPluginSelection(applyMigrationSkillSelection(plan, opts.skills), opts.plugins);
}
async function createMigrationPlanWithProgress(runtime, opts) {
	const createPlan = async () => await createMigrationPlan(runtime, opts);
	if (opts.json) return selectMigrationItems(await createPlan(), opts);
	return selectMigrationItems(await withProgress({
		label: `Scanning ${opts.provider} migration…`,
		indeterminate: true
	}, async (progress) => {
		progress.setLabel("Reading migration source…");
		const plan = await createPlan();
		progress.tick();
		return plan;
	}), opts);
}
function assertVerifyPluginAppsProvider(providerId, opts) {
	if (opts.verifyPluginApps && providerId !== "codex") throw new Error("--verify-plugin-apps is only supported for Codex migrations.");
}
async function promptCodexMigrationSkillSelection(runtime, plan, opts) {
	if (plan.providerId !== "codex" || opts.yes || opts.json || opts.skills !== void 0 || !process.stdin.isTTY) return plan;
	const skillItems = getSelectableMigrationSkillItems(plan);
	if (skillItems.length === 0) return plan;
	const selected = await promptMigrationSelectionValues({
		message: stylePromptMessage("Select Codex skills to migrate into this agent"),
		options: [
			{
				value: MIGRATION_SELECTION_ACCEPT,
				label: "Accept recommended",
				hint: "Migrate every recommended skill"
			},
			...skillItems.map((item) => {
				const hint = formatMigrationSkillSelectionHint(item);
				return {
					value: getMigrationSkillSelectionValue(item),
					label: formatMigrationSkillSelectionLabel(item),
					hint: hint === void 0 ? void 0 : stylePromptHint(hint)
				};
			}),
			{
				value: MIGRATION_SELECTION_TOGGLE_ALL_ON,
				label: "Toggle all on"
			},
			{
				value: MIGRATION_SELECTION_TOGGLE_ALL_OFF,
				label: "Toggle all off"
			}
		],
		initialValues: getDefaultMigrationSkillSelectionValues(skillItems),
		required: false,
		selectableValues: skillItems.map(getMigrationSkillSelectionValue),
		cursorAt: MIGRATION_SELECTION_ACCEPT
	});
	if (isCancel(selected)) {
		cancel(stylePromptTitle("Migration cancelled.") ?? "Migration cancelled.");
		runtime.log("Migration cancelled.");
		return null;
	}
	const selection = resolveInteractiveMigrationSkillSelection(skillItems, selected ?? []);
	const selectedPlan = applyMigrationSelectedSkillItemIds(plan, selection.selectedItemIds);
	runtime.log(`Selected ${selection.selectedItemIds.size} of ${skillItems.length} Codex skills for migration.`);
	return selectedPlan;
}
async function promptCodexMigrationPluginSelection(runtime, plan, opts) {
	if (plan.providerId !== "codex" || opts.yes || opts.json || opts.plugins !== void 0 || !process.stdin.isTTY) return plan;
	const pluginItems = getSelectableMigrationPluginItems(plan);
	if (pluginItems.length === 0) return plan;
	const selected = await promptMigrationSelectionValues({
		message: stylePromptMessage("Select native Codex plugins to activate in this agent"),
		options: [
			{
				value: MIGRATION_SELECTION_ACCEPT,
				label: "Accept recommended",
				hint: "Migrate every recommended plugin"
			},
			...pluginItems.map((item) => {
				const hint = formatMigrationPluginSelectionHint(item);
				return {
					value: getMigrationPluginSelectionValue(item),
					label: formatMigrationPluginSelectionLabel(item),
					hint: hint === void 0 ? void 0 : stylePromptHint(hint)
				};
			}),
			{
				value: MIGRATION_SELECTION_TOGGLE_ALL_ON,
				label: "Toggle all on"
			},
			{
				value: MIGRATION_SELECTION_TOGGLE_ALL_OFF,
				label: "Toggle all off"
			}
		],
		initialValues: getDefaultMigrationPluginSelectionValues(pluginItems),
		required: false,
		selectableValues: pluginItems.map(getMigrationPluginSelectionValue),
		cursorAt: MIGRATION_SELECTION_ACCEPT
	});
	if (isCancel(selected)) {
		cancel(stylePromptTitle("Migration cancelled.") ?? "Migration cancelled.");
		runtime.log("Migration cancelled.");
		return null;
	}
	const selection = resolveInteractiveMigrationPluginSelection(pluginItems, selected ?? []);
	const selectedPlan = applyMigrationSelectedPluginItemIds(plan, selection.selectedItemIds);
	runtime.log(`Selected ${selection.selectedItemIds.size} of ${pluginItems.length} native Codex plugins for activation.`);
	return selectedPlan;
}
async function promptCodexMigrationSelections(runtime, plan, opts) {
	const skillSelectedPlan = await promptCodexMigrationSkillSelection(runtime, plan, opts);
	if (!skillSelectedPlan) return null;
	return await promptCodexMigrationPluginSelection(runtime, skillSelectedPlan, opts);
}
function hasSelectedCodexMigrationWork(plan) {
	return plan.items.some((item) => item.status === "planned" && (item.kind === "skill" && item.action === "copy" || item.kind === "plugin" && item.action === "install"));
}
function shouldSkipCodexApplyAfterInteractiveSelection(plan) {
	return plan.providerId === "codex" && !hasSelectedCodexMigrationWork(plan);
}
function hasCodexSubscriptionRequiredPlugin(plan) {
	if (plan.providerId !== "codex") return false;
	return plan.items.some((item) => item.reason === "codex_subscription_required");
}
function readCodexSubscriptionWarning(plan) {
	return plan.warnings?.find((warning) => warning.includes("Codex app-backed plugin migration requires"));
}
function logNoCodexSelection(runtime, plan) {
	if (hasCodexSubscriptionRequiredPlugin(plan)) {
		const warning = readCodexSubscriptionWarning(plan);
		if (warning) runtime.log(warning);
		runtime.log("No Codex skills selected; native Codex plugins are not eligible for migration in this run.");
		return;
	}
	runtime.log("No Codex skills or native Codex plugins selected for migration.");
}
async function migrateListCommand(runtime, opts = {}) {
	const cfg = getRuntimeConfig();
	ensureStandaloneMigrationProviderRegistryLoaded({ cfg });
	const providers = resolvePluginMigrationProviders({ cfg }).map((provider) => ({
		id: provider.id,
		label: provider.label,
		description: provider.description
	}));
	if (opts.json) {
		writeRuntimeJson(runtime, { providers });
		return;
	}
	if (providers.length === 0) {
		runtime.log(`No migration providers found. Run ${formatCliCommand("openclaw plugins list")} to verify provider plugins are installed and enabled.`);
		return;
	}
	runtime.log(providers.map((provider) => provider.description ? `${provider.id}\t${provider.label} - ${provider.description}` : `${provider.id}\t${provider.label}`).join("\n"));
}
async function migratePlanCommand(runtime, opts) {
	const providerId = opts.provider?.trim();
	if (!providerId) throw new Error(`Migration provider is required. Run ${formatCliCommand("openclaw migrate list")} to choose one.`);
	assertVerifyPluginAppsProvider(providerId, opts);
	const plan = await createMigrationPlanWithProgress(runtime, {
		...opts,
		provider: providerId
	});
	if (opts.json) writeRuntimeJson(runtime, redactMigrationPlan(plan));
	else if (opts.suppressPlanLog !== true) log.message(formatMigrationPreview(plan).join("\n"));
	return plan;
}
async function migrateApplyCommand(runtime, opts) {
	const providerId = opts.provider?.trim();
	if (!providerId) throw new Error(`Migration provider is required. Run ${formatCliCommand("openclaw migrate list")} to choose one.`);
	assertVerifyPluginAppsProvider(providerId, opts);
	if (opts.noBackup && !opts.force) throw new Error("--no-backup requires --force because it skips the automatic rollback copy.");
	if (!opts.yes && !process.stdin.isTTY) throw new Error(`openclaw migrate apply requires --yes in non-interactive mode. Preview first with ${formatCliCommand("openclaw migrate plan --provider <provider>")}.`);
	const provider = resolveMigrationProvider(providerId, opts.configOverride);
	if (!opts.yes) {
		const plan = await migratePlanCommand(runtime, {
			...opts,
			provider: providerId,
			json: opts.json
		});
		if (opts.json) return plan;
		const selectedPlan = await promptCodexMigrationSelections(runtime, plan, opts);
		if (!selectedPlan) return plan;
		if (shouldSkipCodexApplyAfterInteractiveSelection(selectedPlan)) {
			logNoCodexSelection(runtime, selectedPlan);
			return selectedPlan;
		}
		if (!await promptYesNo("Apply this migration now?", false)) {
			runtime.log("Migration cancelled.");
			return selectedPlan;
		}
		return await runMigrationApply({
			runtime,
			opts: {
				...opts,
				provider: providerId,
				yes: true,
				preflightPlan: selectedPlan
			},
			providerId,
			provider
		});
	}
	return await runMigrationApply({
		runtime,
		opts,
		providerId,
		provider
	});
}
async function migrateDefaultCommand(runtime, opts) {
	const providerId = opts.provider?.trim();
	if (!providerId) {
		await migrateListCommand(runtime, { json: opts.json });
		return {
			providerId: "list",
			source: "",
			summary: {
				total: 0,
				planned: 0,
				migrated: 0,
				skipped: 0,
				conflicts: 0,
				errors: 0,
				sensitive: 0
			},
			items: []
		};
	}
	assertVerifyPluginAppsProvider(providerId, opts);
	const plan = opts.json && opts.yes && !opts.dryRun ? selectMigrationItems(await createMigrationPlan(runtime, {
		...opts,
		provider: providerId
	}), opts) : await migratePlanCommand(runtime, {
		...opts,
		provider: providerId,
		json: opts.json && (opts.dryRun || !opts.yes)
	});
	if (opts.dryRun) return plan;
	if (opts.json && !opts.yes) return plan;
	if (!opts.yes) {
		if (!process.stdin.isTTY) {
			runtime.log("Re-run with --yes to apply this migration non-interactively.");
			return plan;
		}
		const selectedPlan = await promptCodexMigrationSelections(runtime, plan, opts);
		if (!selectedPlan) return plan;
		if (shouldSkipCodexApplyAfterInteractiveSelection(selectedPlan)) {
			logNoCodexSelection(runtime, selectedPlan);
			return selectedPlan;
		}
		if (!await promptYesNo("Apply this migration now?", false)) {
			runtime.log("Migration cancelled.");
			return selectedPlan;
		}
		return await migrateApplyCommand(runtime, {
			...opts,
			provider: providerId,
			yes: true,
			json: opts.json,
			preflightPlan: selectedPlan
		});
	}
	return await migrateApplyCommand(runtime, {
		...opts,
		provider: providerId,
		yes: true,
		json: opts.json,
		preflightPlan: plan
	});
}
//#endregion
export { migratePlanCommand as i, migrateDefaultCommand as n, migrateListCommand as r, migrateApplyCommand as t };
