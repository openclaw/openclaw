import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
//#region extensions/memory-core/src/dreaming-repair.ts
const DREAMS_FILENAMES = ["DREAMS.md", "dreams.md"];
const SESSION_CORPUS_RELATIVE_DIR = path.join("memory", ".dreams", "session-corpus");
const SESSION_INGESTION_RELATIVE_PATH = path.join("memory", ".dreams", "session-ingestion.json");
const REPAIR_ARCHIVE_RELATIVE_DIR = path.join(".openclaw-repair", "dreaming");
const DREAMING_NARRATIVE_RUN_PREFIX = "dreaming-narrative-";
const DREAMING_NARRATIVE_PROMPT_PREFIX = "Write a dream diary entry from these memory fragments";
function requireAbsoluteWorkspaceDir(rawWorkspaceDir) {
	const trimmed = rawWorkspaceDir.trim();
	if (!trimmed) throw new Error("workspaceDir is required");
	if (!path.isAbsolute(trimmed)) throw new Error("workspaceDir must be an absolute path");
	return path.resolve(trimmed);
}
async function resolveExistingDreamsPath(workspaceDir) {
	for (const fileName of DREAMS_FILENAMES) {
		const candidate = path.join(workspaceDir, fileName);
		try {
			await fs.access(candidate);
			return candidate;
		} catch (err) {
			if (err.code !== "ENOENT") throw err;
		}
	}
}
async function listSessionCorpusFiles(sessionCorpusDir) {
	return (await fs.readdir(sessionCorpusDir, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith(".txt")).map((entry) => path.join(sessionCorpusDir, entry.name)).toSorted();
}
function isSuspiciousSessionCorpusLine(line) {
	return line.includes(DREAMING_NARRATIVE_PROMPT_PREFIX) && (line.includes(DREAMING_NARRATIVE_RUN_PREFIX) || line.includes("dreaming-narrative-"));
}
function buildArchiveTimestamp(now) {
	return now.toISOString().replace(/[:.]/g, "-");
}
async function ensureArchivablePath(targetPath) {
	const stat = await fs.lstat(targetPath).catch((err) => {
		if (err.code === "ENOENT") return null;
		throw err;
	});
	if (!stat) return null;
	if (stat.isSymbolicLink()) throw new Error(`Refusing to archive symlinked path: ${targetPath}`);
	if (stat.isDirectory()) return "dir";
	if (stat.isFile()) return "file";
	throw new Error(`Refusing to archive non-file artifact: ${targetPath}`);
}
async function moveToArchive(params) {
	if (!await ensureArchivablePath(params.targetPath)) return null;
	await fs.mkdir(params.archiveDir, { recursive: true });
	const baseName = path.basename(params.targetPath);
	const destination = path.join(params.archiveDir, `${baseName}.${randomUUID()}`);
	await fs.rename(params.targetPath, destination);
	return destination;
}
async function auditDreamingArtifacts(params) {
	const workspaceDir = requireAbsoluteWorkspaceDir(params.workspaceDir);
	const dreamsPath = await resolveExistingDreamsPath(workspaceDir);
	const sessionCorpusDir = path.join(workspaceDir, SESSION_CORPUS_RELATIVE_DIR);
	const sessionIngestionPath = path.join(workspaceDir, SESSION_INGESTION_RELATIVE_PATH);
	const issues = [];
	let sessionCorpusFileCount = 0;
	let suspiciousSessionCorpusFileCount = 0;
	let suspiciousSessionCorpusLineCount = 0;
	let sessionIngestionExists = false;
	if (dreamsPath) try {
		await fs.access(dreamsPath);
	} catch (err) {
		issues.push({
			severity: "error",
			code: "dreaming-diary-unreadable",
			message: `Dream diary could not be inspected: ${err.code ?? "error"}.`,
			fixable: false
		});
	}
	try {
		const corpusFiles = await listSessionCorpusFiles(sessionCorpusDir);
		sessionCorpusFileCount = corpusFiles.length;
		for (const corpusFile of corpusFiles) {
			const suspiciousLines = (await fs.readFile(corpusFile, "utf-8")).split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0 && isSuspiciousSessionCorpusLine(line));
			if (suspiciousLines.length > 0) {
				suspiciousSessionCorpusFileCount += 1;
				suspiciousSessionCorpusLineCount += suspiciousLines.length;
			}
		}
	} catch (err) {
		if (err.code !== "ENOENT") issues.push({
			severity: "error",
			code: "dreaming-session-corpus-unreadable",
			message: `Dreaming session corpus could not be inspected: ${err.code ?? "error"}.`,
			fixable: false
		});
	}
	try {
		await fs.access(sessionIngestionPath);
		sessionIngestionExists = true;
	} catch (err) {
		if (err.code !== "ENOENT") issues.push({
			severity: "error",
			code: "dreaming-session-ingestion-unreadable",
			message: `Dreaming session-ingestion state could not be inspected: ${err.code ?? "error"}.`,
			fixable: false
		});
	}
	if (suspiciousSessionCorpusLineCount > 0) issues.push({
		severity: "warn",
		code: "dreaming-session-corpus-self-ingested",
		message: `Dreaming session corpus appears to contain self-ingested narrative content (${suspiciousSessionCorpusLineCount} suspicious line${suspiciousSessionCorpusLineCount === 1 ? "" : "s"}).`,
		fixable: true
	});
	return {
		...dreamsPath ? { dreamsPath } : {},
		sessionCorpusDir,
		sessionCorpusFileCount,
		suspiciousSessionCorpusFileCount,
		suspiciousSessionCorpusLineCount,
		sessionIngestionPath,
		sessionIngestionExists,
		issues
	};
}
async function repairDreamingArtifacts(params) {
	const workspaceDir = requireAbsoluteWorkspaceDir(params.workspaceDir);
	const warnings = [];
	const archivedPaths = [];
	let archiveDir;
	let archivedDreamsDiary = false;
	let archivedSessionCorpus = false;
	let archivedSessionIngestion = false;
	const ensureArchiveDir = () => {
		archiveDir ??= path.join(workspaceDir, REPAIR_ARCHIVE_RELATIVE_DIR, buildArchiveTimestamp(params.now ?? /* @__PURE__ */ new Date()));
		return archiveDir;
	};
	const archivePathIfPresent = async (targetPath) => {
		try {
			return await moveToArchive({
				targetPath,
				archiveDir: ensureArchiveDir()
			});
		} catch (err) {
			warnings.push(err instanceof Error ? err.message : String(err));
			return null;
		}
	};
	const sessionCorpusDestination = await archivePathIfPresent(path.join(workspaceDir, SESSION_CORPUS_RELATIVE_DIR));
	if (sessionCorpusDestination) {
		archivedSessionCorpus = true;
		archivedPaths.push(sessionCorpusDestination);
	}
	const sessionIngestionDestination = await archivePathIfPresent(path.join(workspaceDir, SESSION_INGESTION_RELATIVE_PATH));
	if (sessionIngestionDestination) {
		archivedSessionIngestion = true;
		archivedPaths.push(sessionIngestionDestination);
	}
	if (params.archiveDiary) {
		const dreamsPath = await resolveExistingDreamsPath(workspaceDir);
		if (dreamsPath) {
			const dreamsDestination = await archivePathIfPresent(dreamsPath);
			if (dreamsDestination) {
				archivedDreamsDiary = true;
				archivedPaths.push(dreamsDestination);
			}
		}
	}
	return {
		changed: archivedDreamsDiary || archivedSessionCorpus || archivedSessionIngestion,
		...archiveDir ? { archiveDir } : {},
		archivedDreamsDiary,
		archivedSessionCorpus,
		archivedSessionIngestion,
		archivedPaths,
		warnings
	};
}
//#endregion
export { repairDreamingArtifacts as n, auditDreamingArtifacts as t };
