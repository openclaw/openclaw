import { t as sanitizeTerminalText } from "./safe-text-J_0sTthZ.js";
//#region src/config/issue-format.ts
function normalizeConfigIssuePath(path) {
	if (typeof path !== "string") return "<root>";
	const trimmed = path.trim();
	return trimmed ? trimmed : "<root>";
}
function normalizeConfigIssue(issue) {
	const hasAllowedValues = Array.isArray(issue.allowedValues) && issue.allowedValues.length > 0;
	return {
		path: normalizeConfigIssuePath(issue.path),
		message: issue.message,
		...hasAllowedValues ? { allowedValues: issue.allowedValues } : {},
		...hasAllowedValues && typeof issue.allowedValuesHiddenCount === "number" && issue.allowedValuesHiddenCount > 0 ? { allowedValuesHiddenCount: issue.allowedValuesHiddenCount } : {}
	};
}
function normalizeConfigIssues(issues) {
	return issues.map((issue) => normalizeConfigIssue(issue));
}
function resolveIssuePathForLine(path, opts) {
	if (opts?.normalizeRoot) return normalizeConfigIssuePath(path);
	return typeof path === "string" ? path : "";
}
function formatConfigIssueLine(issue, marker = "-", opts) {
	return `${marker ? `${marker} ` : ""}${sanitizeTerminalText(resolveIssuePathForLine(issue.path, opts))}: ${sanitizeTerminalText(issue.message)}`;
}
function formatConfigIssueLines(issues, marker = "-", opts) {
	return issues.map((issue) => formatConfigIssueLine(issue, marker, opts));
}
function formatConfigIssueSummary(issues, opts = {}) {
	if (issues.length === 0) return null;
	const maxIssueCandidate = Math.floor(opts.maxIssues ?? 5);
	const maxIssues = Number.isFinite(maxIssueCandidate) ? Math.max(1, maxIssueCandidate) : 5;
	const visibleIssues = issues.slice(0, maxIssues);
	const lines = formatConfigIssueLines(visibleIssues, "", { normalizeRoot: opts.normalizeRoot ?? true });
	const hiddenIssueCount = issues.length - visibleIssues.length;
	if (hiddenIssueCount <= 0) return lines.join("; ");
	return `${lines.join("; ")}; and ${hiddenIssueCount} more`;
}
//#endregion
export { normalizeConfigIssuePath as a, normalizeConfigIssue as i, formatConfigIssueLines as n, normalizeConfigIssues as o, formatConfigIssueSummary as r, formatConfigIssueLine as t };
