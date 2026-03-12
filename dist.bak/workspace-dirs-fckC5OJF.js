import { d as resolveDefaultAgentId, u as resolveAgentWorkspaceDir } from "./agent-scope-C2k6BQnt.js";

//#region src/agents/workspace-dirs.ts
function listAgentWorkspaceDirs(cfg) {
	const dirs = /* @__PURE__ */ new Set();
	const list = cfg.agents?.list;
	if (Array.isArray(list)) {
		for (const entry of list) if (entry && typeof entry === "object" && typeof entry.id === "string") dirs.add(resolveAgentWorkspaceDir(cfg, entry.id));
	}
	dirs.add(resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg)));
	return [...dirs];
}

//#endregion
export { listAgentWorkspaceDirs as t };