import { t as formatCliCommand } from "./command-format-DXo6xcsW.js";
import { u as readConfigFileSnapshot } from "./io-BD1XQ5lD.js";
import { n as formatConfigIssueLines } from "./issue-format-u844k3jY.js";
import "./config-CshcuIUd.js";
import { l as formatPluginCompatibilityNotice, r as buildPluginCompatibilitySnapshotNotices } from "./status-B2V8xxu8.js";
//#region src/commands/config-validation.ts
async function requireValidConfigFileSnapshot(runtime, opts) {
	const snapshot = await readConfigFileSnapshot();
	if (snapshot.exists && !snapshot.valid) {
		const issues = snapshot.issues.length > 0 ? formatConfigIssueLines(snapshot.issues, "-").join("\n") : "Unknown validation issue.";
		runtime.error(`Config invalid:\n${issues}`);
		runtime.error(`Fix the config or run ${formatCliCommand("openclaw doctor")}.`);
		runtime.exit(1);
		return null;
	}
	if (opts?.includeCompatibilityAdvisory !== true) return snapshot;
	const compatibility = buildPluginCompatibilitySnapshotNotices({ config: snapshot.config });
	if (compatibility.length > 0) runtime.log([
		`Plugin compatibility: ${compatibility.length} notice${compatibility.length === 1 ? "" : "s"}.`,
		...compatibility.slice(0, 3).map((notice) => `- ${formatPluginCompatibilityNotice(notice)}`),
		...compatibility.length > 3 ? [`- ... +${compatibility.length - 3} more`] : [],
		`Review: ${formatCliCommand("openclaw doctor")}`
	].join("\n"));
	return snapshot;
}
async function requireValidConfigSnapshot(runtime, opts) {
	return (await requireValidConfigFileSnapshot(runtime, opts))?.config ?? null;
}
//#endregion
export { requireValidConfigSnapshot as n, requireValidConfigFileSnapshot as t };
