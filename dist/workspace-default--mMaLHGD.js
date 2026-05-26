import { s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { o as resolveRequiredHomeDir } from "./home-dir-BOPFpGo8.js";
import path from "node:path";
import os from "node:os";
//#region src/agents/workspace-default.ts
function resolveDefaultAgentWorkspaceDir(env = process.env, homedir = os.homedir) {
	const workspaceDir = env.OPENCLAW_WORKSPACE_DIR?.trim();
	if (workspaceDir) return path.resolve(workspaceDir);
	const home = resolveRequiredHomeDir(env, homedir);
	const profile = env.OPENCLAW_PROFILE?.trim();
	if (profile && normalizeOptionalLowercaseString(profile) !== "default") return path.join(home, ".openclaw", `workspace-${profile}`);
	return path.join(home, ".openclaw", "workspace");
}
const DEFAULT_AGENT_WORKSPACE_DIR = resolveDefaultAgentWorkspaceDir();
//#endregion
export { resolveDefaultAgentWorkspaceDir as n, DEFAULT_AGENT_WORKSPACE_DIR as t };
