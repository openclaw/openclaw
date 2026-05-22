import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { i as formatErrorMessage } from "./errors-QN8rySzW.js";
import { r as theme } from "./theme-B128avno.js";
import { n as defaultRuntime, r as writeRuntimeJson } from "./runtime-Dv8n03pi.js";
import { m as searchClawHubPackages } from "./clawhub-CyouiCKz.js";
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
	return [...byName.values()].toSorted((a, b) => b.score - a.score).slice(0, limit);
}
function formatPackageSearchLine(entry) {
	const pkg = entry.package;
	const flags = [
		pkg.family,
		pkg.channel,
		pkg.isOfficial ? "official" : void 0,
		pkg.latestVersion ? `v${pkg.latestVersion}` : void 0
	].filter(Boolean);
	const summary = pkg.summary ? `  ${theme.muted(pkg.summary)}` : "";
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
