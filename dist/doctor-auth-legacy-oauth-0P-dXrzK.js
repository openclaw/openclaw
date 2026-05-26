import { t as sanitizeForLog } from "./ansi-4r6vVvJt.js";
import { n as ensureAuthProfileStore } from "./store-BMQkMM4l.js";
import { t as repairOAuthProfileIdMismatch } from "./repair-BQzHL5co.js";
//#region src/commands/doctor-auth-legacy-oauth.ts
async function loadProviderRuntime() {
	return import("./providers.runtime-CxD5m8e5.js");
}
async function loadNoteRuntime() {
	return import("./note-Ct75aT4E.js");
}
function hasConfigOAuthProfiles(cfg) {
	return Object.values(cfg.auth?.profiles ?? {}).some((profile) => profile?.mode === "oauth");
}
function sanitizePromptLabel(label) {
	return (label ? sanitizeForLog(label).trim() : void 0) || void 0;
}
async function maybeRepairLegacyOAuthProfileIds(cfg, prompter) {
	if (!hasConfigOAuthProfiles(cfg)) return cfg;
	const store = ensureAuthProfileStore();
	if (Object.keys(store.profiles).length === 0) return cfg;
	let nextCfg = cfg;
	const { resolvePluginProviders } = await loadProviderRuntime();
	const providers = resolvePluginProviders({
		config: cfg,
		env: process.env,
		mode: "setup"
	});
	for (const provider of providers) for (const repairSpec of provider.oauthProfileIdRepairs ?? []) {
		const repair = repairOAuthProfileIdMismatch({
			cfg: nextCfg,
			store,
			provider: provider.id,
			legacyProfileId: repairSpec.legacyProfileId
		});
		if (!repair.migrated || repair.changes.length === 0) continue;
		const { note } = await loadNoteRuntime();
		note(repair.changes.map((c) => `- ${c}`).join("\n"), "Auth profiles");
		const label = sanitizePromptLabel(repairSpec.promptLabel) ?? sanitizePromptLabel(provider.label) ?? provider.id;
		if (!await prompter.confirm({
			message: `Update ${label} OAuth profile id in config now?`,
			initialValue: true
		})) continue;
		nextCfg = repair.config;
	}
	return nextCfg;
}
//#endregion
export { maybeRepairLegacyOAuthProfileIds };
