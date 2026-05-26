import { E as pathExists } from "./fs-safe-CV86zY9G.js";
import { J as resolveMemoryDreamingWorkspaces } from "./dreaming-CxCxWYoC.js";
import "./security-runtime-CcSekjBd.js";
import { i as resolveMemoryHostEventLogPath } from "./events-mq9owIje.js";
import "./memory-core-host-status-CceUImkn.js";
import "./memory-host-events-B9F8o8ue.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region extensions/memory-core/src/public-artifacts.ts
async function listMarkdownFilesRecursive(rootDir) {
	const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);
	const files = [];
	for (const entry of entries) {
		const fullPath = path.join(rootDir, entry.name);
		if (entry.isDirectory()) {
			files.push(...await listMarkdownFilesRecursive(fullPath));
			continue;
		}
		if (entry.isFile() && entry.name.endsWith(".md")) files.push(fullPath);
	}
	return files.toSorted((left, right) => left.localeCompare(right));
}
async function collectWorkspaceArtifacts(params) {
	const artifacts = [];
	const workspaceEntries = new Set((await fs.readdir(params.workspaceDir, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isFile()).map((entry) => entry.name));
	for (const relativePath of ["MEMORY.md"]) {
		if (!workspaceEntries.has(relativePath)) continue;
		const absolutePath = path.join(params.workspaceDir, relativePath);
		artifacts.push({
			kind: "memory-root",
			workspaceDir: params.workspaceDir,
			relativePath,
			absolutePath,
			agentIds: [...params.agentIds],
			contentType: "markdown"
		});
	}
	const memoryDir = path.join(params.workspaceDir, "memory");
	for (const absolutePath of await listMarkdownFilesRecursive(memoryDir)) {
		const relativePath = path.relative(params.workspaceDir, absolutePath).replace(/\\/g, "/");
		artifacts.push({
			kind: relativePath.startsWith("memory/dreaming/") ? "dream-report" : "daily-note",
			workspaceDir: params.workspaceDir,
			relativePath,
			absolutePath,
			agentIds: [...params.agentIds],
			contentType: "markdown"
		});
	}
	const eventLogPath = resolveMemoryHostEventLogPath(params.workspaceDir);
	if (await pathExists(eventLogPath)) artifacts.push({
		kind: "event-log",
		workspaceDir: params.workspaceDir,
		relativePath: path.relative(params.workspaceDir, eventLogPath).replace(/\\/g, "/"),
		absolutePath: eventLogPath,
		agentIds: [...params.agentIds],
		contentType: "json"
	});
	const deduped = /* @__PURE__ */ new Map();
	for (const artifact of artifacts) deduped.set(`${artifact.workspaceDir}\0${artifact.relativePath}\0${artifact.kind}`, artifact);
	return [...deduped.values()];
}
async function listMemoryCorePublicArtifacts(params) {
	const workspaces = resolveMemoryDreamingWorkspaces(params.cfg);
	const artifacts = [];
	for (const workspace of workspaces) artifacts.push(...await collectWorkspaceArtifacts({
		workspaceDir: workspace.workspaceDir,
		agentIds: workspace.agentIds
	}));
	return artifacts;
}
//#endregion
export { listMemoryCorePublicArtifacts };
