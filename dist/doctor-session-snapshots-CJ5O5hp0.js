import { t as expandHomePrefix } from "./home-dir-BOPFpGo8.js";
import { y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { g as shortenHomePath } from "./utils-sBTEdeml.js";
import { i as resolveAllAgentSessionStoreTargetsSync } from "./targets-B5o7Ubgb.js";
import { t as resolveBundledSkillsDir } from "./bundled-dir-B-vmTgAr.js";
import { t as note } from "./note-Dg2Luaaq.js";
import fs from "node:fs";
import path from "node:path";
//#region src/commands/doctor-session-snapshots.ts
function decodeXmlText(value) {
	return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
function extractSkillLocations(prompt) {
	if (typeof prompt !== "string" || !prompt.trim()) return [];
	const locations = [];
	for (const match of prompt.matchAll(/<location>([\s\S]*?)<\/location>/g)) {
		const raw = match[1]?.trim();
		if (raw) locations.push(decodeXmlText(raw));
	}
	return locations;
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function collectResolvedSkillPaths(value) {
	if (!Array.isArray(value)) return [];
	const paths = [];
	for (const skill of value) {
		if (!isRecord(skill)) continue;
		if (typeof skill.filePath === "string" && skill.filePath.trim()) paths.push(skill.filePath.trim());
		if (typeof skill.baseDir === "string" && skill.baseDir.trim()) paths.push(path.join(skill.baseDir.trim(), "SKILL.md"));
	}
	return paths;
}
function collectInjectedWorkspaceFilePaths(value) {
	if (!Array.isArray(value)) return [];
	return value.map((entry) => isRecord(entry) && typeof entry.path === "string" ? entry.path.trim() : "").filter(Boolean);
}
function collectCachedSnapshotPaths(entry) {
	const snapshot = entry.skillsSnapshot;
	const report = entry.systemPromptReport;
	const paths = [];
	for (const location of extractSkillLocations(snapshot?.prompt)) paths.push({
		field: "skillsSnapshot.prompt",
		path: location
	});
	for (const location of collectResolvedSkillPaths(snapshot?.resolvedSkills)) paths.push({
		field: "skillsSnapshot.resolvedSkills",
		path: location
	});
	if (isRecord(report)) for (const location of collectInjectedWorkspaceFilePaths(report.injectedWorkspaceFiles)) paths.push({
		field: "systemPromptReport.injectedWorkspaceFiles",
		path: location
	});
	return paths;
}
function isAbsolutePathLike(value) {
	return path.isAbsolute(value) || path.win32.isAbsolute(value);
}
function splitPathSegments(value) {
	return value.replace(/^[a-z]:/i, "").replaceAll("\\", "/").split("/").filter(Boolean);
}
function isWindowsAbsolutePath(value) {
	return /^[a-z]:/i.test(value) && ["/", "\\"].includes(value.slice(2, 3)) || value.startsWith("\\\\");
}
function isTempBackedOpenClawRoot(segments) {
	const lower = segments.map((segment) => segment.toLowerCase());
	const openclawIndex = lower.lastIndexOf("openclaw");
	if (openclawIndex < 1) return false;
	return lower[openclawIndex - 1] === "tmp" || lower[openclawIndex - 1] === "temp";
}
function isBundledRuntimeSkillsPath(cachedPath, skillRootIndex) {
	const beforeSkillRoot = splitPathSegments(cachedPath).slice(0, skillRootIndex);
	return beforeSkillRoot.map((segment) => segment.toLowerCase()).some((segment) => segment === "dist-runtime" || segment === "node_modules" || segment.startsWith("openclaw@")) || isTempBackedOpenClawRoot(beforeSkillRoot);
}
function extractBundledSkillRelativeSegments(cachedPath) {
	const segments = splitPathSegments(cachedPath);
	const skillRootIndex = segments.lastIndexOf("skills");
	if (skillRootIndex < 0 || !isBundledRuntimeSkillsPath(cachedPath, skillRootIndex)) return;
	const relativeSegments = segments.slice(skillRootIndex + 1);
	if (relativeSegments.length < 2 || relativeSegments.at(-1) !== "SKILL.md") return;
	return relativeSegments;
}
function isInsidePath(baseDir, candidatePath) {
	const baseIsWindows = isWindowsAbsolutePath(baseDir);
	if (baseIsWindows !== isWindowsAbsolutePath(candidatePath)) return false;
	const pathApi = baseIsWindows ? path.win32 : path;
	const relative = pathApi.relative(pathApi.resolve(baseDir), pathApi.resolve(candidatePath));
	return relative === "" || !!relative && !relative.startsWith("..") && !pathApi.isAbsolute(relative);
}
function joinPathForRoot(root, ...segments) {
	return isWindowsAbsolutePath(root) ? path.win32.join(root, ...segments) : path.join(root, ...segments);
}
function resolveExpectedBundledSkillPath(params) {
	const expandedCachedPath = expandHomePrefix(params.cachedPath, {
		home: params.homeDir,
		env: params.env
	});
	if (!isAbsolutePathLike(expandedCachedPath)) return;
	if (isInsidePath(params.bundledSkillsDir, expandedCachedPath)) return;
	const relativeSegments = extractBundledSkillRelativeSegments(expandedCachedPath);
	if (!relativeSegments) return;
	const expectedPath = joinPathForRoot(params.bundledSkillsDir, ...relativeSegments);
	return params.pathExists(expectedPath) ? expectedPath : void 0;
}
function scanSessionStoreForStaleRuntimeSnapshotPaths(params) {
	const bundledSkillsDir = params.bundledSkillsDir?.trim();
	if (!bundledSkillsDir) return [];
	const pathExists = params.pathExists ?? fs.existsSync;
	const findings = [];
	const seen = /* @__PURE__ */ new Set();
	for (const [sessionKey, entry] of Object.entries(params.store)) {
		if (!entry || typeof entry !== "object") continue;
		for (const cached of collectCachedSnapshotPaths(entry)) {
			const expectedPath = resolveExpectedBundledSkillPath({
				cachedPath: cached.path,
				bundledSkillsDir,
				pathExists,
				homeDir: params.homeDir,
				env: params.env
			});
			if (!expectedPath) continue;
			const key = `${sessionKey}\0${cached.field}\0${cached.path}`;
			if (seen.has(key)) continue;
			seen.add(key);
			findings.push({
				sessionKey,
				field: cached.field,
				cachedPath: cached.path,
				expectedPath
			});
		}
	}
	return findings;
}
async function listSessionStorePaths(stateDir) {
	const agentsDir = path.join(stateDir, "agents");
	let agentEntries = [];
	try {
		agentEntries = await fs.promises.readdir(agentsDir, { withFileTypes: true });
	} catch {
		return [];
	}
	return agentEntries.filter((entry) => entry.isDirectory()).map((entry) => path.join(agentsDir, entry.name, "sessions", "sessions.json")).filter((storePath) => fs.existsSync(storePath)).toSorted((a, b) => a.localeCompare(b));
}
function resolveSessionStorePaths(params) {
	if (!params.cfg) return;
	return resolveAllAgentSessionStoreTargetsSync(params.cfg, { env: params.env }).map((target) => target.storePath).filter((storePath) => fs.existsSync(storePath)).toSorted((a, b) => a.localeCompare(b));
}
function loadSessionStoreForSnapshotScan(storePath) {
	const parsed = JSON.parse(fs.readFileSync(storePath, "utf-8"));
	return isRecord(parsed) ? parsed : {};
}
async function noteSessionSnapshotHealth(params) {
	const bundledSkillsDir = params?.bundledSkillsDir ?? resolveBundledSkillsDir();
	if (!bundledSkillsDir) return;
	const storePaths = params?.storePaths ?? resolveSessionStorePaths({
		cfg: params?.cfg,
		env: params?.env
	}) ?? await listSessionStorePaths(resolveStateDir(params?.env));
	const findingsByStore = /* @__PURE__ */ new Map();
	for (const storePath of storePaths) {
		let store;
		try {
			store = loadSessionStoreForSnapshotScan(storePath);
		} catch (err) {
			note(`- Failed to inspect session snapshot metadata in ${shortenHomePath(storePath)}: ${String(err)}`, "Session snapshots");
			continue;
		}
		const findings = scanSessionStoreForStaleRuntimeSnapshotPaths({
			store,
			bundledSkillsDir,
			env: params?.env
		});
		if (findings.length > 0) findingsByStore.set(storePath, findings);
	}
	const totalFindings = [...findingsByStore.values()].reduce((total, findings) => total + findings.length, 0);
	if (totalFindings === 0) return;
	const affectedSessions = new Set([...findingsByStore.values()].flatMap((findings) => findings.map((finding) => finding.sessionKey)));
	const lines = [
		`- Found ${affectedSessions.size} session${affectedSessions.size === 1 ? "" : "s"} with stale cached session metadata paths.`,
		`  Live bundled skills root is healthy: ${shortenHomePath(bundledSkillsDir)}`,
		"  Cached session metadata still references an inactive runtime root; start a fresh session or reset the affected long-lived sessions after confirming history can be retired."
	];
	let shown = 0;
	for (const [storePath, findings] of findingsByStore) {
		lines.push(`  Store: ${shortenHomePath(storePath)}`);
		for (const finding of findings.slice(0, Math.max(0, 10 - shown))) {
			lines.push(`  - ${finding.sessionKey} ${finding.field}: ${shortenHomePath(finding.cachedPath)} -> ${shortenHomePath(finding.expectedPath)}`);
			shown += 1;
			if (shown >= 10) break;
		}
		if (shown >= 10) break;
	}
	if (totalFindings > shown) lines.push(`  ...and ${totalFindings - shown} more stale cached path${totalFindings - shown === 1 ? "" : "s"}.`);
	note(lines.join("\n"), "Session snapshots");
}
//#endregion
export { noteSessionSnapshotHealth };
