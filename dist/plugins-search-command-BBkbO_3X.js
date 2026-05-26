import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { r as theme } from "./theme-D58JpUfy.js";
import { n as defaultRuntime, r as writeRuntimeJson } from "./runtime-yzlkhCoS.js";
import { m as searchClawHubPackages } from "./clawhub-B9rdLaiz.js";
//#region src/cli/plugins-search-command.ts
const INSTALLABLE_PLUGIN_FAMILIES = ["code-plugin", "bundle-plugin"];
function clampSearchLimit(limit) {
	if (!Number.isFinite(limit) || !limit || limit <= 0) return 20;
	return Math.min(Math.max(Math.trunc(limit), 1), 100);
}
function mergePackageSearchResults(groups, limit) {
	const byName = /* @__PURE__ */ new Map();
	for (const entry of groups.flat()) {
		const existing = byName.get(entry.package.name);
		if (!existing || entry.score > existing.score) byName.set(entry.package.name, entry);
	}
	const selected = [];
	for (const entry of byName.values()) {
		let insertAt = selected.length;
		for (let index = 0; index < selected.length; index += 1) if (entry.score > selected[index].score) {
			insertAt = index;
			break;
		}
		if (insertAt < limit) {
			selected.splice(insertAt, 0, entry);
			if (selected.length > limit) selected.pop();
		} else if (selected.length < limit) selected.push(entry);
	}
	return selected;
}
function formatPackageSearchLine(entry) {
	const pkg = entry.package;
	const flags = [
		pkg.family,
		pkg.channel,
		pkg.isOfficial && pkg.channel !== "official" ? "official" : void 0,
		pkg.latestVersion ? `v${pkg.latestVersion}` : void 0
	].filter(Boolean);
	const summary = pkg.summary ? theme.muted(` — ${pkg.summary}`) : "";
	return `${pkg.name}  ${theme.muted(flags.join(" | "))}${summary}\n  ${theme.muted(`Install: openclaw plugins install clawhub:${pkg.name}`)}`;
}
async function runPluginsSearchCommand(queryParts, opts = {}, runtime = defaultRuntime) {
	const query = normalizeOptionalString(Array.isArray(queryParts) ? queryParts.join(" ") : queryParts);
	if (!query) {
		runtime.error("Usage: openclaw plugins search <query>");
		return runtime.exit(1);
	}
	const limit = clampSearchLimit(opts.limit);
	try {
		const results = mergePackageSearchResults(await Promise.all(INSTALLABLE_PLUGIN_FAMILIES.map((family) => searchClawHubPackages({
			query,
			family,
			limit
		}))), limit);
		if (opts.json) {
			writeRuntimeJson(runtime, { results });
			return;
		}
		if (results.length === 0) {
			runtime.log("No ClawHub plugins found.");
			return;
		}
		runtime.log(`${theme.heading("ClawHub plugins")} ${theme.muted(`(${results.length})`)}`);
		runtime.log(results.map(formatPackageSearchLine).join("\n"));
	} catch (error) {
		runtime.error(formatErrorMessage(error));
		runtime.exit(1);
	}
}
//#endregion
export { runPluginsSearchCommand };
