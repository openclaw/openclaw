import { t as findGitRoot } from "./git-root-Coo034-P.js";
import { i as resolveUserTimezone, r as resolveUserTimeFormat, t as formatUserTime } from "./date-time-D45sDlB1.js";
import fs from "node:fs";
import path from "node:path";
//#region src/agents/system-prompt-params.ts
function buildSystemPromptParams(params) {
	const repoRoot = resolveRepoRoot({
		config: params.config,
		workspaceDir: params.workspaceDir,
		cwd: params.cwd
	});
	const userTimezone = resolveUserTimezone(params.config?.agents?.defaults?.userTimezone);
	const userTimeFormat = resolveUserTimeFormat(params.config?.agents?.defaults?.timeFormat);
	const userTime = formatUserTime(/* @__PURE__ */ new Date(), userTimezone, userTimeFormat);
	return {
		runtimeInfo: {
			agentId: params.agentId,
			...params.runtime,
			repoRoot
		},
		userTimezone,
		userTime,
		userTimeFormat
	};
}
function resolveRepoRoot(params) {
	const configured = params.config?.agents?.defaults?.repoRoot?.trim();
	if (configured) try {
		const resolved = path.resolve(configured);
		if (fs.statSync(resolved).isDirectory()) return resolved;
	} catch {}
	const candidates = [params.workspaceDir, params.cwd].map((value) => value?.trim()).filter(Boolean);
	const seen = /* @__PURE__ */ new Set();
	for (const candidate of candidates) {
		const resolved = path.resolve(candidate);
		if (seen.has(resolved)) continue;
		seen.add(resolved);
		const root = findGitRoot(resolved);
		if (root) return root;
	}
}
//#endregion
export { buildSystemPromptParams as t };
