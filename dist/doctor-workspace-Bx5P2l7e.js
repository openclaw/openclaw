import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { g as shortenHomePath } from "./utils-sBTEdeml.js";
import "./agent-scope-CtLXGcWm.js";
import { c as resolveDefaultAgentId, o as resolveAgentWorkspaceDir } from "./agent-scope-config-CMp71_27.js";
import { a as resolveCanonicalRootMemoryPath, n as LEGACY_ROOT_MEMORY_FILENAME, o as resolveLegacyRootMemoryPath, s as resolveRootMemoryRepairDir, t as CANONICAL_ROOT_MEMORY_FILENAME } from "./root-memory-files-P2Mok0xY.js";
import { t as DEFAULT_AGENTS_FILENAME } from "./workspace-DTx8zuCN.js";
import { t as note } from "./note-Dg2Luaaq.js";
import fs from "node:fs";
import path from "node:path";
//#region src/commands/doctor-workspace.ts
const MEMORY_SYSTEM_PROMPT = [
	"Memory system not found in workspace.",
	"Paste this into your agent:",
	"",
	"Install the memory system by applying:",
	"https://github.com/openclaw/openclaw/commit/9ffea23f31ca1df5183b25668f8f814bee0fb34e",
	"https://github.com/openclaw/openclaw/commit/7d1fee70e76f2f634f1b41fca927ee663914183a"
].join("\n");
async function shouldSuggestMemorySystem(workspaceDir) {
	if ((await listWorkspaceEntries(workspaceDir)).has("MEMORY.md")) try {
		if ((await fs.promises.stat(resolveCanonicalRootMemoryPath(workspaceDir))).isFile()) return false;
	} catch {}
	const agentsPath = path.join(workspaceDir, DEFAULT_AGENTS_FILENAME);
	try {
		const content = await fs.promises.readFile(agentsPath, "utf-8");
		if (new RegExp(`\\b${"MEMORY.md".replace(".", "\\.")}\\b`).test(content)) return false;
	} catch {}
	return true;
}
function detectLegacyWorkspaceDirs(params) {
	return {
		activeWorkspace: path.resolve(params.workspaceDir),
		legacyDirs: []
	};
}
function formatLegacyWorkspaceWarning(detection) {
	return [
		"Extra workspace directories detected (may contain old agent files):",
		...detection.legacyDirs.map((dir) => `- ${shortenHomePath(dir)}`),
		`Active workspace: ${shortenHomePath(detection.activeWorkspace)}`,
		"If unused, archive or move to Trash."
	].join("\n");
}
async function statIfExists(filePath) {
	try {
		const stat = await fs.promises.stat(filePath);
		if (!stat.isFile()) return { exists: false };
		return {
			exists: true,
			bytes: stat.size
		};
	} catch (err) {
		if (err?.code === "ENOENT") return { exists: false };
		throw err;
	}
}
async function listWorkspaceEntries(workspaceDir) {
	try {
		return new Set(await fs.promises.readdir(workspaceDir));
	} catch (err) {
		if (err?.code === "ENOENT") return /* @__PURE__ */ new Set();
		throw err;
	}
}
async function detectRootMemoryFiles(workspaceDir) {
	const resolvedWorkspace = path.resolve(workspaceDir);
	const canonicalPath = resolveCanonicalRootMemoryPath(resolvedWorkspace);
	const legacyPath = resolveLegacyRootMemoryPath(resolvedWorkspace);
	const entries = await listWorkspaceEntries(resolvedWorkspace);
	const [canonical, legacy] = await Promise.all([entries.has("MEMORY.md") ? statIfExists(canonicalPath) : Promise.resolve({ exists: false }), entries.has("memory.md") ? statIfExists(legacyPath) : Promise.resolve({ exists: false })]);
	return {
		workspaceDir: resolvedWorkspace,
		canonicalPath,
		legacyPath,
		canonicalExists: canonical.exists,
		legacyExists: legacy.exists,
		...typeof canonical.bytes === "number" ? { canonicalBytes: canonical.bytes } : {},
		...typeof legacy.bytes === "number" ? { legacyBytes: legacy.bytes } : {}
	};
}
function formatBytes(bytes) {
	return typeof bytes === "number" ? `${bytes} bytes` : "size unknown";
}
function formatRootMemoryFilesWarning(detection) {
	if (detection.canonicalExists && detection.legacyExists) return [
		"Split root durable memory files detected:",
		`- canonical: ${shortenHomePath(detection.canonicalPath)} (${formatBytes(detection.canonicalBytes)})`,
		`- legacy: ${shortenHomePath(detection.legacyPath)} (${formatBytes(detection.legacyBytes)})`,
		`OpenClaw uses ${CANONICAL_ROOT_MEMORY_FILENAME} as the canonical durable memory file.`,
		`Dreaming writes durable promotions to ${CANONICAL_ROOT_MEMORY_FILENAME}, so older facts in ${LEGACY_ROOT_MEMORY_FILENAME} can be shadowed.`,
		`Run "openclaw doctor --fix" to merge the legacy file into ${CANONICAL_ROOT_MEMORY_FILENAME} with a backup.`
	].join("\n");
	return null;
}
async function moveLegacyRootMemoryFileToArchive(params) {
	const repairDir = resolveRootMemoryRepairDir(params.workspaceDir);
	await fs.promises.mkdir(repairDir, { recursive: true });
	const archiveDir = path.join(repairDir, (/* @__PURE__ */ new Date()).toISOString().replaceAll(":", "-").replaceAll(".", "-"));
	await fs.promises.mkdir(archiveDir, { recursive: true });
	const archivePath = path.join(archiveDir, LEGACY_ROOT_MEMORY_FILENAME);
	try {
		await fs.promises.rename(params.legacyPath, archivePath);
	} catch (err) {
		if (err?.code !== "EXDEV") throw err;
		await fs.promises.copyFile(params.legacyPath, archivePath);
		await fs.promises.unlink(params.legacyPath);
	}
	return archivePath;
}
function buildMergedLegacyRootMemorySection(params) {
	return [
		"",
		`## Imported From Legacy Root ${LEGACY_ROOT_MEMORY_FILENAME}`,
		"",
		`<!-- openclaw-root-memory-merge source=${LEGACY_ROOT_MEMORY_FILENAME} archived=${params.archivedLegacyPath} -->`,
		`This content came from legacy root \`${LEGACY_ROOT_MEMORY_FILENAME}\`, which was shadowed by \`${CANONICAL_ROOT_MEMORY_FILENAME}\`.`,
		"",
		params.legacyText.trim(),
		""
	].join("\n");
}
async function migrateLegacyRootMemoryFile(workspaceDir) {
	const detection = await detectRootMemoryFiles(workspaceDir);
	if (!detection.canonicalExists || !detection.legacyExists) return {
		changed: false,
		canonicalPath: detection.canonicalPath,
		legacyPath: detection.legacyPath,
		removedLegacy: false,
		mergedLegacy: false
	};
	const archivedLegacyPath = await moveLegacyRootMemoryFileToArchive({
		workspaceDir: detection.workspaceDir,
		legacyPath: detection.legacyPath
	});
	const [canonicalText, legacyText] = await Promise.all([fs.promises.readFile(detection.canonicalPath, "utf-8"), fs.promises.readFile(archivedLegacyPath, "utf-8")]);
	if (canonicalText !== legacyText) {
		const merged = `${canonicalText.trimEnd()}\n${buildMergedLegacyRootMemorySection({
			legacyText,
			archivedLegacyPath: shortenHomePath(archivedLegacyPath)
		})}`;
		await fs.promises.writeFile(detection.canonicalPath, merged, "utf-8");
	}
	return {
		changed: true,
		canonicalPath: detection.canonicalPath,
		legacyPath: detection.legacyPath,
		removedLegacy: true,
		mergedLegacy: canonicalText !== legacyText,
		archivedLegacyPath,
		...typeof detection.legacyBytes === "number" ? { copiedBytes: detection.legacyBytes } : {}
	};
}
async function noteWorkspaceMemoryHealth(cfg) {
	try {
		const rootMemoryWarning = formatRootMemoryFilesWarning(await detectRootMemoryFiles(resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg))));
		if (rootMemoryWarning) note(rootMemoryWarning, "Workspace memory");
	} catch (err) {
		note(`Workspace memory audit could not be completed: ${formatErrorMessage(err)}`, "Doctor");
	}
}
async function maybeRepairWorkspaceMemoryHealth(params) {
	try {
		const agentId = resolveDefaultAgentId(params.cfg);
		const configuredWorkspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
		const rootMemoryFiles = await detectRootMemoryFiles(configuredWorkspaceDir);
		if (!rootMemoryFiles.canonicalExists || !rootMemoryFiles.legacyExists) return;
		if (!await params.prompter.confirmRuntimeRepair({
			message: `Merge legacy root memory.md into canonical MEMORY.md and remove the shadowed file?`,
			initialValue: true
		})) return;
		const migration = await migrateLegacyRootMemoryFile(configuredWorkspaceDir);
		if (!migration.changed) return;
		note([
			"Workspace memory root merged:",
			`- canonical: ${migration.canonicalPath}`,
			migration.archivedLegacyPath ? `- backup: ${migration.archivedLegacyPath}` : null,
			migration.mergedLegacy ? `- merged legacy content from: ${migration.legacyPath}` : null,
			migration.removedLegacy ? `- removed legacy file: ${migration.legacyPath}` : `- legacy file still present: ${migration.legacyPath}`
		].filter(Boolean).join("\n"), "Doctor changes");
	} catch (err) {
		note(`Workspace memory repair could not be completed: ${formatErrorMessage(err)}`, "Doctor");
	}
}
//#endregion
export { formatRootMemoryFilesWarning as a, noteWorkspaceMemoryHealth as c, formatLegacyWorkspaceWarning as i, shouldSuggestMemorySystem as l, detectLegacyWorkspaceDirs as n, maybeRepairWorkspaceMemoryHealth as o, detectRootMemoryFiles as r, migrateLegacyRootMemoryFile as s, MEMORY_SYSTEM_PROMPT as t };
