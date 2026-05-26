import { t as resolveOpenClawPackageRoot } from "./openclaw-root-CNp1Ofdk.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { n as VERSION } from "./version-CQfgAE7_.js";
import { l as resolveRegistryUpdateChannel, s as normalizeUpdateChannel } from "./update-channels-f-ieRme5.js";
import { n as compareSemverStrings, t as checkUpdateStatus } from "./update-check-Bp4i15ma.js";
//#region src/commands/status.update.ts
async function getUpdateCheckResult(params) {
	const configChannel = normalizeUpdateChannel(params.updateConfigChannel);
	return await checkUpdateStatus({
		root: await resolveOpenClawPackageRoot({
			moduleUrl: import.meta.url,
			argv1: process.argv[1],
			cwd: process.cwd()
		}),
		timeoutMs: params.timeoutMs,
		fetchGit: params.fetchGit,
		includeRegistry: params.includeRegistry,
		registryChannel: resolveRegistryUpdateChannel({
			configChannel,
			currentVersion: VERSION
		})
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
		const registryLabel = update.registry?.tag && update.registry.tag !== "latest" ? `npm ${update.registry.tag}` : "npm latest";
		if (update.registry?.latestVersion) {
			const cmp = compareSemverStrings(VERSION, update.registry.latestVersion);
			if (cmp === 0) {
				if (update.installKind !== "git") parts.push("up to date");
				parts.push(`${registryLabel} ${update.registry.latestVersion}`);
			} else if (cmp != null && cmp < 0) parts.push(update.registry.tag && update.registry.tag !== "latest" ? `${registryLabel} update ${update.registry.latestVersion}` : `npm update ${update.registry.latestVersion}`);
			else parts.push(`${registryLabel} ${update.registry.latestVersion} (local newer)`);
			return;
		}
		if (update.registry?.error) parts.push(`${registryLabel} unknown`);
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
