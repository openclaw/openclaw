import { t as formatCliCommand } from "./command-format-CDHXQh1_.js";
import { t as resolveOpenClawPackageRoot } from "./openclaw-root-C9tYgTzw.js";
import { r as VERSION } from "./env-vars-DPtuUD7z.js";
import { n as checkUpdateStatus, r as compareSemverStrings } from "./channel-account-context-CvN7490K.js";

//#region src/commands/status.update.ts
async function getUpdateCheckResult(params) {
	return await checkUpdateStatus({
		root: await resolveOpenClawPackageRoot({
			moduleUrl: import.meta.url,
			argv1: process.argv[1],
			cwd: process.cwd()
		}),
		timeoutMs: params.timeoutMs,
		fetchGit: params.fetchGit,
		includeRegistry: params.includeRegistry
	});
}
function resolveUpdateAvailability(update) {
	const latestVersion = update.registry?.latestVersion ?? null;
	const registryCmp = latestVersion ? compareSemverStrings(VERSION, latestVersion) : null;
	const hasRegistryUpdate = registryCmp != null && registryCmp < 0;
	const gitBehind = update.installKind === "git" && typeof update.git?.behind === "number" ? update.git.behind : null;
	const hasGitUpdate = gitBehind != null && gitBehind > 0;
	return {
		available: hasGitUpdate || hasRegistryUpdate,
		hasGitUpdate,
		hasRegistryUpdate,
		latestVersion: hasRegistryUpdate ? latestVersion : null,
		gitBehind
	};
}
function formatUpdateAvailableHint(update) {
	const availability = resolveUpdateAvailability(update);
	if (!availability.available) return null;
	const details = [];
	if (availability.hasGitUpdate && availability.gitBehind != null) details.push(`git behind ${availability.gitBehind}`);
	if (availability.hasRegistryUpdate && availability.latestVersion) details.push(`npm ${availability.latestVersion}`);
	return `Update available${details.length > 0 ? ` (${details.join(" · ")})` : ""}. Run: ${formatCliCommand("openclaw update")}`;
}
function formatUpdateOneLiner(update) {
	const parts = [];
	const appendRegistryUpdateSummary = () => {
		if (update.registry?.latestVersion) {
			const cmp = compareSemverStrings(VERSION, update.registry.latestVersion);
			if (cmp === 0) parts.push(`npm latest ${update.registry.latestVersion}`);
			else if (cmp != null && cmp < 0) parts.push(`npm update ${update.registry.latestVersion}`);
			else parts.push(`npm latest ${update.registry.latestVersion} (local newer)`);
			return;
		}
		if (update.registry?.error) parts.push("npm latest unknown");
	};
	if (update.installKind === "git" && update.git) {
		const branch = update.git.branch ? `git ${update.git.branch}` : "git";
		parts.push(branch);
		if (update.git.upstream) parts.push(`↔ ${update.git.upstream}`);
		if (update.git.dirty === true) parts.push("dirty");
		if (update.git.behind != null && update.git.ahead != null) {
			if (update.git.behind === 0 && update.git.ahead === 0) parts.push("up to date");
			else if (update.git.behind > 0 && update.git.ahead === 0) parts.push(`behind ${update.git.behind}`);
			else if (update.git.behind === 0 && update.git.ahead > 0) parts.push(`ahead ${update.git.ahead}`);
			else if (update.git.behind > 0 && update.git.ahead > 0) parts.push(`diverged (ahead ${update.git.ahead}, behind ${update.git.behind})`);
		}
		if (update.git.fetchOk === false) parts.push("fetch failed");
		appendRegistryUpdateSummary();
	} else {
		parts.push(update.packageManager !== "unknown" ? update.packageManager : "pkg");
		appendRegistryUpdateSummary();
	}
	if (update.deps) {
		if (update.deps.status === "ok") parts.push("deps ok");
		if (update.deps.status === "missing") parts.push("deps missing");
		if (update.deps.status === "stale") parts.push("deps stale");
	}
	return `Update: ${parts.join(" · ")}`;
}

//#endregion
export { resolveUpdateAvailability as i, formatUpdateOneLiner as n, getUpdateCheckResult as r, formatUpdateAvailableHint as t };