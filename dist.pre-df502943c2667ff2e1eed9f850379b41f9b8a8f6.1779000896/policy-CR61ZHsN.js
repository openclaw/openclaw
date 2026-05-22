import { o as detectInlineEvalInSegments } from "./risks-O3mzO6Eg.js";
import { c as analyzeArgvCommand, l as analyzeShellCommand } from "./exec-approvals-allowlist-Fj-I7d1g.js";
//#region src/infra/command-analysis/policy.ts
function analyzeCommandForPolicy(params) {
	const analysis = params.source === "shell" ? analyzeShellCommand({
		command: params.command,
		cwd: params.cwd,
		env: params.env,
		platform: params.platform
	}) : analyzeArgvCommand({
		argv: params.argv,
		cwd: params.cwd,
		env: params.env
	});
	if (!analysis.ok) return {
		ok: false,
		source: params.source,
		reason: analysis.reason,
		analysis,
		segments: []
	};
	return {
		ok: true,
		source: params.source,
		analysis,
		segments: analysis.segments
	};
}
function detectPolicyInlineEval(segments) {
	return detectInlineEvalInSegments(segments);
}
//#endregion
export { detectPolicyInlineEval as n, analyzeCommandForPolicy as t };
