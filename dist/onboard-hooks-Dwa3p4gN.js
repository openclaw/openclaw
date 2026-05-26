import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import "./agent-scope-CtLXGcWm.js";
import { c as resolveDefaultAgentId, o as resolveAgentWorkspaceDir } from "./agent-scope-config-CMp71_27.js";
import { n as t } from "./i18n-CWNhN747.js";
import { t as buildWorkspaceHookStatus } from "./hooks-status-CCLCPEft.js";
//#region src/commands/onboard-hooks.ts
async function setupInternalHooks(cfg, _runtime, prompter) {
	await prompter.note([
		"Hooks let you automate actions when agent commands are issued.",
		"Example: Save session context to memory when you issue /new or /reset.",
		"",
		"Learn more: https://docs.openclaw.ai/automation/hooks"
	].join("\n"), t("wizard.hooks.introTitle"));
	const eligibleHooks = buildWorkspaceHookStatus(resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg)), { config: cfg }).hooks.filter((h) => h.loadable);
	if (eligibleHooks.length === 0) {
		await prompter.note(t("wizard.hooks.noHooksMessage"), t("wizard.hooks.noHooksTitle"));
		return cfg;
	}
	const selected = (await prompter.multiselect({
		message: t("wizard.hooks.enable"),
		options: [{
			value: "__skip__",
			label: t("common.skipForNow")
		}, ...eligibleHooks.map((hook) => ({
			value: hook.name,
			label: `${hook.emoji ?? "🔗"} ${hook.name}`,
			hint: hook.description
		}))]
	})).filter((name) => name !== "__skip__");
	if (selected.length === 0) return cfg;
	const entries = { ...cfg.hooks?.internal?.entries };
	for (const name of selected) entries[name] = { enabled: true };
	const next = {
		...cfg,
		hooks: {
			...cfg.hooks,
			internal: {
				enabled: true,
				entries
			}
		}
	};
	await prompter.note([
		`Enabled ${selected.length} hook${selected.length > 1 ? "s" : ""}: ${selected.join(", ")}`,
		"",
		"You can manage hooks later with:",
		`  ${formatCliCommand("openclaw hooks list")}`,
		`  ${formatCliCommand("openclaw hooks enable <name>")}`,
		`  ${formatCliCommand("openclaw hooks disable <name>")}`
	].join("\n"), t("wizard.hooks.configuredTitle"));
	return next;
}
//#endregion
export { setupInternalHooks };
