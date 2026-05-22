import { t as formatCliCommand } from "./command-format-OwPqnbXG.js";
import { r as theme } from "./theme-Clp64kpu.js";
import { n as defaultRuntime, r as writeRuntimeJson } from "./runtime-Bd9_VI2J.js";
import { n as promptYesNo } from "./prompt-oJz6Q6tp.js";
import { i as getRuntimeConfig } from "./io-BTdvKaBm.js";
import "./config-DuPmRSz4.js";
import { n as stylePromptMessage, r as stylePromptTitle, t as stylePromptHint } from "./prompt-style-BfOeIspm.js";
import { n as runCommandWithRuntime } from "./cli-utils-DSE6y8Sz.js";
import { t as formatHelpExamples } from "./help-format-BMRz9Zqb.js";
import { g as redactMigrationPlan } from "./migration-DWhJg4yc.js";
import { n as resolvePluginMigrationProvider, r as resolvePluginMigrationProviders, t as ensureStandaloneMigrationProviderRegistryLoaded } from "./migration-provider-runtime-CUs0k-X-.js";
import { t as buildMigrationContext } from "./context-xses8TAQ.js";
import { C as reconcileInteractiveMigrationSkillToggleValues, S as reconcileInteractiveMigrationShortcutValues, T as resolveInteractiveMigrationSkillSelection, _ as getDefaultMigrationSkillSelectionValues, a as MIGRATION_SELECTION_SKIP, b as getSelectableMigrationPluginItems, c as applyMigrationPluginSelection, d as applyMigrationSkillSelection, f as formatMigrationPluginSelectionHint, g as getDefaultMigrationPluginSelectionValues, h as formatMigrationSkillSelectionLabel, l as applyMigrationSelectedPluginItemIds, m as formatMigrationSkillSelectionHint, o as MIGRATION_SELECTION_TOGGLE_ALL_OFF, p as formatMigrationPluginSelectionLabel, r as formatMigrationPlan, s as MIGRATION_SELECTION_TOGGLE_ALL_ON, u as applyMigrationSelectedSkillItemIds, v as getMigrationPluginSelectionValue, w as resolveInteractiveMigrationPluginSelection, x as getSelectableMigrationSkillItems, y as getMigrationSkillSelectionValue } from "./output-Blqx_A0Z.js";
import { n as runMigrationApply } from "./apply-D4GbNp81.js";
import { styleText } from "node:util";
import { S_BAR, S_BAR_END, S_CHECKBOX_ACTIVE, S_CHECKBOX_INACTIVE, S_CHECKBOX_SELECTED, cancel, isCancel, limitOptions, symbol, symbolBar } from "@clack/prompts";
import { MultiSelectPrompt, settings, wrapTextWithPrefix } from "@clack/core";
//#region src/commands/migrate/providers.ts
function resolveMigrationProvider(providerId) {
	const config = getRuntimeConfig();
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
async function createMigrationPlan(runtime, opts) {
	const provider = resolveMigrationProvider(opts.provider);
	const ctx = buildMigrationContext({
		source: opts.source,
		includeSecrets: opts.includeSecrets,
		overwrite: opts.overwrite,
		runtime,
		json: opts.json
	});
	return await provider.plan(ctx);
}
//#endregion
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
	prompt.on("cursor", (key) => {
		if (key !== "space") return;
		const activatedValue = prompt.options[prompt.cursor]?.value;
		prompt.value = reconcileInteractiveMigrationSkillToggleValues(prompt.value ?? [], activatedValue, opts.selectableValues);
		lastSelectedValues = [...prompt.value ?? []];
	});
	prompt.on("key", (key) => {
		if (key !== "a" && key !== "i") return;
		prompt.value = reconcileInteractiveMigrationShortcutValues(lastSelectedValues, prompt.value ?? [], opts.selectableValues, key);
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
async function promptCodexMigrationSkillSelection(runtime, plan, opts) {
	if (plan.providerId !== "codex" || opts.yes || opts.json || opts.skills !== void 0 || !process.stdin.isTTY) return plan;
	const skillItems = getSelectableMigrationSkillItems(plan);
	if (skillItems.length === 0) return plan;
	const selected = await promptMigrationSelectionValues({
		message: stylePromptMessage("Select Codex skills to migrate into this agent"),
		options: [
			{
				value: MIGRATION_SELECTION_SKIP,
				label: "Skip for now"
			},
			{
				value: MIGRATION_SELECTION_TOGGLE_ALL_ON,
				label: "Toggle all on"
			},
			{
				value: MIGRATION_SELECTION_TOGGLE_ALL_OFF,
				label: "Toggle all off"
			},
			...skillItems.map((item) => {
				const hint = formatMigrationSkillSelectionHint(item);
				return {
					value: getMigrationSkillSelectionValue(item),
					label: formatMigrationSkillSelectionLabel(item),
					hint: hint === void 0 ? void 0 : stylePromptHint(hint)
				};
			})
		],
		initialValues: getDefaultMigrationSkillSelectionValues(skillItems),
		required: false,
		selectableValues: skillItems.map(getMigrationSkillSelectionValue)
	});
	if (isCancel(selected)) {
		cancel(stylePromptTitle("Migration cancelled.") ?? "Migration cancelled.");
		runtime.log("Migration cancelled.");
		return null;
	}
	const selection = resolveInteractiveMigrationSkillSelection(skillItems, selected ?? []);
	if (selection.action === "skip") {
		runtime.log("Codex skill migration skipped for now.");
		return applyMigrationSelectedSkillItemIds(plan, /* @__PURE__ */ new Set());
	}
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
				value: MIGRATION_SELECTION_SKIP,
				label: "Skip for now"
			},
			{
				value: MIGRATION_SELECTION_TOGGLE_ALL_ON,
				label: "Toggle all on"
			},
			{
				value: MIGRATION_SELECTION_TOGGLE_ALL_OFF,
				label: "Toggle all off"
			},
			...pluginItems.map((item) => {
				const hint = formatMigrationPluginSelectionHint(item);
				return {
					value: getMigrationPluginSelectionValue(item),
					label: formatMigrationPluginSelectionLabel(item),
					hint: hint === void 0 ? void 0 : stylePromptHint(hint)
				};
			})
		],
		initialValues: getDefaultMigrationPluginSelectionValues(pluginItems),
		required: false,
		selectableValues: pluginItems.map(getMigrationPluginSelectionValue)
	});
	if (isCancel(selected)) {
		cancel(stylePromptTitle("Migration cancelled.") ?? "Migration cancelled.");
		runtime.log("Migration cancelled.");
		return null;
	}
	const selection = resolveInteractiveMigrationPluginSelection(pluginItems, selected ?? []);
	if (selection.action === "skip") {
		runtime.log("Codex plugin migration skipped for now.");
		return null;
	}
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
function logNoCodexSelection(runtime) {
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
	const plan = selectMigrationItems(await createMigrationPlan(runtime, {
		...opts,
		provider: providerId
	}), opts);
	if (opts.json) writeRuntimeJson(runtime, redactMigrationPlan(plan));
	else runtime.log(formatMigrationPlan(plan).join("\n"));
	return plan;
}
async function migrateApplyCommand(runtime, opts) {
	const providerId = opts.provider?.trim();
	if (!providerId) throw new Error(`Migration provider is required. Run ${formatCliCommand("openclaw migrate list")} to choose one.`);
	if (opts.noBackup && !opts.force) throw new Error("--no-backup requires --force because it skips the automatic rollback copy.");
	if (!opts.yes && !process.stdin.isTTY) throw new Error(`openclaw migrate apply requires --yes in non-interactive mode. Preview first with ${formatCliCommand("openclaw migrate plan --provider <provider>")}.`);
	const provider = resolveMigrationProvider(providerId);
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
			logNoCodexSelection(runtime);
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
			logNoCodexSelection(runtime);
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
//#region src/cli/program/register.migrate.ts
function collectMigrationSkill(value, previous) {
	return [...previous ?? [], value];
}
function collectMigrationPlugin(value, previous) {
	return [...previous ?? [], value];
}
function readMigrationSkills(value) {
	if (!Array.isArray(value)) return;
	const skills = value.filter((item) => typeof item === "string").map((item) => item.trim()).filter((item) => item.length > 0);
	return skills.length > 0 ? skills : void 0;
}
function readMigrationPlugins(value) {
	if (!Array.isArray(value)) return;
	const plugins = value.filter((item) => typeof item === "string").map((item) => item.trim()).filter((item) => item.length > 0);
	return plugins.length > 0 ? plugins : void 0;
}
function addMigrationSkillOption(command) {
	return command.option("--skill <name>", "Select one skill to migrate by name or item id; repeat for multiple skills", collectMigrationSkill);
}
function addMigrationPluginOption(command) {
	return command.option("--plugin <name>", "Select one Codex plugin to migrate by name or item id; repeat for multiple plugins", collectMigrationPlugin);
}
function addMigrationOptions(command) {
	return addMigrationPluginOption(addMigrationSkillOption(command.option("--from <path>", "Source directory to migrate from").option("--include-secrets", "Import supported credentials and secrets", false).option("--overwrite", "Overwrite conflicting target files after item-level backups", false).option("--json", "Output JSON", false)));
}
function registerMigrateCommand(program) {
	const migrate = program.command("migrate").description("Import state from another agent system").argument("[provider]", "Migration provider id, for example hermes").option("--from <path>", "Source directory to migrate from").option("--include-secrets", "Import supported credentials and secrets", false).option("--overwrite", "Overwrite conflicting target files after item-level backups", false).option("--dry-run", "Preview only; do not apply changes", false).option("--yes", "Apply without prompting after preview", false).option("--skill <name>", "Select one skill to migrate by name or item id; repeat for multiple skills", collectMigrationSkill).option("--plugin <name>", "Select one Codex plugin to migrate by name or item id; repeat for multiple plugins", collectMigrationPlugin).option("--backup-output <path>", "Pre-migration backup archive path or directory").option("--no-backup", "Skip the pre-migration OpenClaw backup").option("--force", "Allow dangerous options such as --no-backup", false).option("--json", "Output JSON", false).addHelpText("after", () => `\n${theme.heading("Examples:")}\n${formatHelpExamples([
		["openclaw migrate list", "Show available migration providers."],
		["openclaw migrate hermes", "Preview Hermes migration, then prompt before applying."],
		["openclaw migrate hermes --dry-run", "Preview Hermes migration only."],
		["openclaw migrate apply hermes --yes", "Apply Hermes migration non-interactively after writing a verified backup."],
		["openclaw migrate apply hermes --include-secrets --yes", "Include supported credentials in the migration."]
	])}`).action(async (provider, opts) => {
		await runCommandWithRuntime(defaultRuntime, async () => {
			await migrateDefaultCommand(defaultRuntime, {
				provider,
				source: opts.from,
				includeSecrets: Boolean(opts.includeSecrets),
				overwrite: Boolean(opts.overwrite),
				skills: readMigrationSkills(opts.skill),
				plugins: readMigrationPlugins(opts.plugin),
				dryRun: Boolean(opts.dryRun),
				yes: Boolean(opts.yes),
				backupOutput: opts.backupOutput,
				noBackup: opts.backup === false,
				force: Boolean(opts.force),
				json: Boolean(opts.json)
			});
		});
	});
	migrate.command("list").description("List migration providers").option("--json", "Output JSON", false).action(async (opts) => {
		await runCommandWithRuntime(defaultRuntime, async () => {
			await migrateListCommand(defaultRuntime, { json: Boolean(opts.json) });
		});
	});
	addMigrationOptions(migrate.command("plan <provider>").description("Preview a migration without changing OpenClaw state")).action(async (provider, opts) => {
		await runCommandWithRuntime(defaultRuntime, async () => {
			await migratePlanCommand(defaultRuntime, {
				provider,
				source: opts.from,
				includeSecrets: Boolean(opts.includeSecrets),
				overwrite: Boolean(opts.overwrite),
				skills: readMigrationSkills(opts.skill),
				plugins: readMigrationPlugins(opts.plugin),
				json: Boolean(opts.json)
			});
		});
	});
	addMigrationOptions(migrate.command("apply <provider>").description("Apply a migration after a verified backup")).option("--yes", "Apply without prompting", false).option("--backup-output <path>", "Pre-migration backup archive path or directory").option("--no-backup", "Skip the pre-migration OpenClaw backup").option("--force", "Allow dangerous options such as --no-backup", false).action(async (provider, opts) => {
		await runCommandWithRuntime(defaultRuntime, async () => {
			await migrateApplyCommand(defaultRuntime, {
				provider,
				source: opts.from,
				includeSecrets: Boolean(opts.includeSecrets),
				overwrite: Boolean(opts.overwrite),
				skills: readMigrationSkills(opts.skill),
				plugins: readMigrationPlugins(opts.plugin),
				yes: Boolean(opts.yes),
				backupOutput: opts.backupOutput,
				noBackup: opts.backup === false,
				force: Boolean(opts.force),
				json: Boolean(opts.json)
			});
		});
	});
}
//#endregion
export { registerMigrateCommand };
