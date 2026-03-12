import { r as resolveCliName } from "./command-format-CDHXQh1_.js";
import { t as resolveOpenClawPackageRoot } from "./openclaw-root-C9tYgTzw.js";
import { t as note } from "./note-DQ26Rw8p.js";
import { a as resolveCompletionCachePath, i as isCompletionInstalled, o as resolveShellFromEnv, r as installCompletion, s as usesSlowDynamicCompletion, t as completionCacheExists } from "./completion-cli-ChV4uLTl.js";
import { spawnSync } from "node:child_process";
import path from "node:path";

//#region src/commands/doctor-completion.ts
/** Generate the completion cache by spawning the CLI. */
async function generateCompletionCache() {
	const root = await resolveOpenClawPackageRoot({
		moduleUrl: import.meta.url,
		argv1: process.argv[1],
		cwd: process.cwd()
	});
	if (!root) return false;
	const binPath = path.join(root, "openclaw.mjs");
	return spawnSync(process.execPath, [
		binPath,
		"completion",
		"--write-state"
	], {
		cwd: root,
		env: process.env,
		encoding: "utf-8"
	}).status === 0;
}
/** Check the status of shell completion for the current shell. */
async function checkShellCompletionStatus(binName = "openclaw") {
	const shell = resolveShellFromEnv();
	return {
		shell,
		profileInstalled: await isCompletionInstalled(shell, binName),
		cacheExists: await completionCacheExists(shell, binName),
		cachePath: resolveCompletionCachePath(shell, binName),
		usesSlowPattern: await usesSlowDynamicCompletion(shell, binName)
	};
}
/**
* Doctor check for shell completion.
* - If profile uses slow dynamic pattern: upgrade to cached version
* - If profile has completion but no cache: auto-generate cache and upgrade profile
* - If no completion at all: prompt to install (with user confirmation)
*/
async function doctorShellCompletion(runtime, prompter, options = {}) {
	const cliName = resolveCliName();
	const status = await checkShellCompletionStatus(cliName);
	if (status.usesSlowPattern) {
		note(`Your ${status.shell} profile uses slow dynamic completion (source <(...)).\nUpgrading to cached completion for faster shell startup...`, "Shell completion");
		if (!status.cacheExists) {
			if (!await generateCompletionCache()) {
				note(`Failed to generate completion cache. Run \`${cliName} completion --write-state\` manually.`, "Shell completion");
				return;
			}
		}
		await installCompletion(status.shell, true, cliName);
		note(`Shell completion upgraded. Restart your shell or run: source ~/.${status.shell === "zsh" ? "zshrc" : status.shell === "bash" ? "bashrc" : "config/fish/config.fish"}`, "Shell completion");
		return;
	}
	if (status.profileInstalled && !status.cacheExists) {
		note(`Shell completion is configured in your ${status.shell} profile but the cache is missing.\nRegenerating cache...`, "Shell completion");
		if (await generateCompletionCache()) note(`Completion cache regenerated at ${status.cachePath}`, "Shell completion");
		else note(`Failed to regenerate completion cache. Run \`${cliName} completion --write-state\` manually.`, "Shell completion");
		return;
	}
	if (!status.profileInstalled) {
		if (options.nonInteractive) return;
		if (await prompter.confirm({
			message: `Enable ${status.shell} shell completion for ${cliName}?`,
			initialValue: true
		})) {
			if (!await generateCompletionCache()) {
				note(`Failed to generate completion cache. Run \`${cliName} completion --write-state\` manually.`, "Shell completion");
				return;
			}
			await installCompletion(status.shell, true, cliName);
			note(`Shell completion installed. Restart your shell or run: source ~/.${status.shell === "zsh" ? "zshrc" : status.shell === "bash" ? "bashrc" : "config/fish/config.fish"}`, "Shell completion");
		}
	}
}
/**
* Ensure completion cache exists. Used during onboarding/update to fix
* cases where profile has completion but no cache.
* This is a silent fix - no prompts.
*/
async function ensureCompletionCacheExists(binName = "openclaw") {
	if (await completionCacheExists(resolveShellFromEnv(), binName)) return true;
	return generateCompletionCache();
}

//#endregion
export { doctorShellCompletion as n, ensureCompletionCacheExists as r, checkShellCompletionStatus as t };