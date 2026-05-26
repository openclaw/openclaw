import { h as loadWorkspaceBootstrapFiles } from "./workspace-DTx8zuCN.js";
//#region src/agents/bootstrap-cache.ts
const cache = /* @__PURE__ */ new Map();
function bootstrapFilesEqual(previous, next) {
	if (previous.length !== next.length) return false;
	return previous.every((file, index) => {
		const updated = next[index];
		return updated !== void 0 && file.name === updated.name && file.path === updated.path && file.content === updated.content && file.missing === updated.missing;
	});
}
async function getOrLoadBootstrapFiles(params) {
	const existing = cache.get(params.sessionKey);
	const files = await loadWorkspaceBootstrapFiles(params.workspaceDir);
	if (existing && existing.workspaceDir === params.workspaceDir && bootstrapFilesEqual(existing.files, files)) return existing.files;
	cache.set(params.sessionKey, {
		workspaceDir: params.workspaceDir,
		files
	});
	return files;
}
function clearBootstrapSnapshot(sessionKey) {
	cache.delete(sessionKey);
}
function clearBootstrapSnapshotOnSessionRollover(params) {
	if (!params.sessionKey || !params.previousSessionId) return;
	clearBootstrapSnapshot(params.sessionKey);
}
//#endregion
export { clearBootstrapSnapshotOnSessionRollover as n, getOrLoadBootstrapFiles as r, clearBootstrapSnapshot as t };
