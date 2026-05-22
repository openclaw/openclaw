import { r as theme } from "./theme-B128avno.js";
import { r as writeRuntimeJson } from "./runtime-CFpTi2zA.js";
import { g as redactMigrationPlan } from "./migration-DGRzQTG5.js";
//#region src/commands/migrate/output.ts
function formatCount(value, label) {
	return `${value} ${label}${value === 1 ? "" : "s"}`;
}
function formatMigrationPlan(plan) {
	const lines = [`${theme.heading("Migration plan:")} ${plan.providerId}`, `Source: ${plan.source}`];
	if (plan.target) lines.push(`Target: ${plan.target}`);
	lines.push([
		formatCount(plan.summary.total, "item"),
		formatCount(plan.summary.conflicts, "conflict"),
		formatCount(plan.summary.sensitive, "sensitive item")
	].join(", "));
	if (plan.warnings && plan.warnings.length > 0) {
		lines.push("");
		lines.push(theme.warn("Warnings:"));
		for (const warning of plan.warnings) lines.push(`- ${warning}`);
	}
	const visibleItems = plan.items.slice(0, 25);
	if (visibleItems.length > 0) {
		lines.push("");
		lines.push(theme.heading("Items:"));
		for (const item of visibleItems) lines.push(formatMigrationItem(item));
		if (plan.items.length > visibleItems.length) lines.push(`- ... ${plan.items.length - visibleItems.length} more`);
	}
	if (plan.nextSteps && plan.nextSteps.length > 0) {
		lines.push("");
		lines.push(theme.heading("Next:"));
		for (const step of plan.nextSteps) lines.push(`- ${step}`);
	}
	return lines;
}
function formatMigrationItem(item) {
	const target = item.target ? ` -> ${item.target}` : "";
	const message = item.message ? ` (${item.message})` : item.reason ? ` (${item.reason})` : "";
	const sensitive = item.sensitive ? " [sensitive]" : "";
	return `- ${item.status}: ${item.kind}/${item.action} ${item.id}${target}${sensitive}${message}`;
}
function assertConflictFreePlan(plan, providerId) {
	if (plan.summary.conflicts > 0) throw new Error(`Migration has ${formatCount(plan.summary.conflicts, "conflict")}. Re-run with --overwrite after reviewing openclaw migrate plan ${providerId}.`);
}
function writeApplyResult(runtime, opts, result) {
	if (opts.json) {
		writeRuntimeJson(runtime, redactMigrationPlan(result));
		return;
	}
	runtime.log(formatMigrationPlan(result).join("\n"));
	if (result.backupPath) runtime.log(`Backup: ${result.backupPath}`);
	else if (!opts.noBackup) runtime.log("Backup: skipped (no existing OpenClaw state found)");
	if (result.reportDir) runtime.log(`Report: ${result.reportDir}`);
}
function assertApplySucceeded(result) {
	if (result.summary.errors === 0 && result.summary.conflicts === 0) return;
	const reportHint = result.reportDir ? ` See report: ${result.reportDir}.` : "";
	if (result.summary.errors > 0) throw new Error(`Migration finished with ${formatCount(result.summary.errors, "error")}.${reportHint}`);
	throw new Error(`Migration finished with ${formatCount(result.summary.conflicts, "conflict")}.${reportHint}`);
}
//#endregion
export { writeApplyResult as i, assertConflictFreePlan as n, formatMigrationPlan as r, assertApplySucceeded as t };
