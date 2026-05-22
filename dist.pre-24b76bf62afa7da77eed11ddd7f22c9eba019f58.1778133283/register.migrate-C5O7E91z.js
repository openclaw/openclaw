import { r as theme } from "./theme-CVJvORNs.js";
import { n as defaultRuntime, r as writeRuntimeJson } from "./runtime-bzt9CHmD.js";
import { t as promptYesNo } from "./prompt-Dn7PN4Ip.js";
import { i as getRuntimeConfig } from "./io-DOE5w-Qp.js";
import "./config-C_YnpthU.js";
import { n as stylePromptMessage, r as stylePromptTitle, t as stylePromptHint } from "./prompt-style-BYvfT2l5.js";
import { n as runCommandWithRuntime } from "./cli-utils-c5l36GrW.js";
import { t as formatHelpExamples } from "./help-format-GSSilIei.js";
import { g as redactMigrationPlan } from "./migration-CWT6aN-1.js";
import { n as resolvePluginMigrationProvider, r as resolvePluginMigrationProviders, t as ensureStandaloneMigrationProviderRegistryLoaded } from "./migration-provider-runtime-BqAtQ427.js";
import { t as buildMigrationContext } from "./context-C8Pf3je7.js";
import { r as formatMigrationPlan } from "./output-HuXrxD-d.js";
import { a as formatMigrationSkillSelectionHint, c as getSelectableMigrationSkillItems, i as applyMigrationSkillSelection, n as runMigrationApply, o as formatMigrationSkillSelectionLabel, r as applyMigrationSelectedSkillItemIds, s as getMigrationSkillSelectionValue } from "./apply-CeoFF5Tc.js";
import { cancel, isCancel, multiselect } from "@clack/prompts";
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
//#region src/commands/migrate.ts
function selectMigrationSkills(plan, opts) {
	return applyMigrationSkillSelection(plan, opts.skills);
}
async function promptCodexMigrationSkillSelection(runtime, plan, opts) {
	if (plan.providerId !== "codex" || opts.yes || opts.json || opts.skills !== void 0 || !process.stdin.isTTY) return plan;
	const skillItems = getSelectableMigrationSkillItems(plan);
	if (skillItems.length === 0) return plan;
	const selected = await multiselect({
		message: stylePromptMessage("Select Codex skills to migrate into this agent"),
		options: skillItems.map((item) => {
			const hint = formatMigrationSkillSelectionHint(item);
			return {
				value: getMigrationSkillSelectionValue(item),
				label: formatMigrationSkillSelectionLabel(item),
				hint: hint === void 0 ? void 0 : stylePromptHint(hint)
			};
		}),
		initialValues: skillItems.map(getMigrationSkillSelectionValue),
		required: false
	});
	if (isCancel(selected)) {
		cancel(stylePromptTitle("Migration cancelled.") ?? "Migration cancelled.");
		runtime.log("Migration cancelled.");
		return null;
	}
	const selectedPlan = applyMigrationSelectedSkillItemIds(plan, new Set(selected));
	runtime.log(`Selected ${selected.length} of ${skillItems.length} Codex skills for migration.`);
	return selectedPlan;
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
		runtime.log("No migration providers found.");
		return;
	}
	runtime.log(providers.map((provider) => provider.description ? `${provider.id}\t${provider.label} - ${provider.description}` : `${provider.id}\t${provider.label}`).join("\n"));
}
async function migratePlanCommand(runtime, opts) {
	const providerId = opts.provider?.trim();
	if (!providerId) throw new Error("Migration provider is required.");
	const plan = selectMigrationSkills(await createMigrationPlan(runtime, {
		...opts,
		provider: providerId
	}), opts);
	if (opts.json) writeRuntimeJson(runtime, redactMigrationPlan(plan));
	else runtime.log(formatMigrationPlan(plan).join("\n"));
	return plan;
}
async function migrateApplyCommand(runtime, opts) {
	const providerId = opts.provider?.trim();
	if (!providerId) throw new Error("Migration provider is required.");
	if (opts.noBackup && !opts.force) throw new Error("--no-backup requires --force.");
	if (!opts.yes && !process.stdin.isTTY) throw new Error("openclaw migrate apply requires --yes in non-interactive mode.");
	const provider = resolveMigrationProvider(providerId);
	if (!opts.yes) {
		const plan = await migratePlanCommand(runtime, {
			...opts,
			provider: providerId,
			json: opts.json
		});
		if (opts.json) return plan;
		const selectedPlan = await promptCodexMigrationSkillSelection(runtime, plan, opts);
		if (!selectedPlan) return plan;
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
	const plan = opts.json && opts.yes && !opts.dryRun ? selectMigrationSkills(await createMigrationPlan(runtime, {
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
		const selectedPlan = await promptCodexMigrationSkillSelection(runtime, plan, opts);
		if (!selectedPlan) return plan;
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
function readMigrationSkills(value) {
	if (!Array.isArray(value)) return;
	const skills = value.filter((item) => typeof item === "string").map((item) => item.trim()).filter((item) => item.length > 0);
	return skills.length > 0 ? skills : void 0;
}
function addMigrationSkillOption(command) {
	return command.option("--skill <name>", "Select one skill to migrate by name or item id; repeat for multiple skills", collectMigrationSkill);
}
function addMigrationOptions(command) {
	return addMigrationSkillOption(command.option("--from <path>", "Source directory to migrate from").option("--include-secrets", "Import supported credentials and secrets", false).option("--overwrite", "Overwrite conflicting target files after item-level backups", false).option("--json", "Output JSON", false));
}
function registerMigrateCommand(program) {
	const migrate = program.command("migrate").description("Import state from another agent system").argument("[provider]", "Migration provider id, for example hermes").option("--from <path>", "Source directory to migrate from").option("--include-secrets", "Import supported credentials and secrets", false).option("--overwrite", "Overwrite conflicting target files after item-level backups", false).option("--dry-run", "Preview only; do not apply changes", false).option("--yes", "Apply without prompting after preview", false).option("--skill <name>", "Select one skill to migrate by name or item id; repeat for multiple skills", collectMigrationSkill).option("--backup-output <path>", "Pre-migration backup archive path or directory").option("--no-backup", "Skip the pre-migration OpenClaw backup").option("--force", "Allow dangerous options such as --no-backup", false).option("--json", "Output JSON", false).addHelpText("after", () => `\n${theme.heading("Examples:")}\n${formatHelpExamples([
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
