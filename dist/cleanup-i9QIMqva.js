import { i as isPathInside } from "./path-BlG8lhgR.js";
import "./path-guards-CBe_wA_B.js";
import { i as resolveSessionFilePath } from "./paths-Bg3PO6Gj.js";
import { a as resolveTrajectoryPointerFilePath, i as resolveTrajectoryFilePath, s as safeTrajectorySessionFileName } from "./paths-CzW2SUx5.js";
import fs from "node:fs";
import path from "node:path";
//#region src/trajectory/cleanup.ts
function isRecord(value) {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
function canonicalizePathForComparison(filePath) {
	const resolved = path.resolve(filePath);
	try {
		return fs.realpathSync(resolved);
	} catch {
		return resolved;
	}
}
function isPathWithinDir(parentDir, filePath) {
	const resolvedParent = canonicalizePathForComparison(parentDir);
	const resolvedFile = canonicalizePathForComparison(filePath);
	return resolvedFile !== resolvedParent && isPathInside(resolvedParent, resolvedFile);
}
function isRegularNonSymlinkFile(filePath) {
	try {
		const lst = fs.lstatSync(filePath);
		if (!lst.isFile() || lst.isSymbolicLink()) return false;
		return fs.statSync(filePath).isFile();
	} catch {
		return false;
	}
}
function readTrajectoryPointerFile(pointerPath, sessionId) {
	if (!isRegularNonSymlinkFile(pointerPath)) return null;
	try {
		const parsed = JSON.parse(fs.readFileSync(pointerPath, "utf8"));
		if (!isRecord(parsed)) return null;
		if (parsed.traceSchema !== "openclaw-trajectory-pointer" || parsed.schemaVersion !== 1 || parsed.sessionId !== sessionId || typeof parsed.runtimeFile !== "string" || !parsed.runtimeFile.trim()) return null;
		return { runtimeFile: path.resolve(parsed.runtimeFile) };
	} catch {
		return null;
	}
}
function readFirstNonEmptyLine(filePath) {
	let fd = null;
	try {
		fd = fs.openSync(filePath, "r");
		const buffer = Buffer.alloc(64 * 1024);
		const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
		if (bytesRead <= 0) return null;
		for (const line of buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/u)) {
			const trimmed = line.trim();
			if (trimmed) return trimmed;
		}
		return null;
	} catch {
		return null;
	} finally {
		if (fd !== null) try {
			fs.closeSync(fd);
		} catch {}
	}
}
function runtimeFileStartsWithSessionEvent(filePath, sessionId) {
	if (!isRegularNonSymlinkFile(filePath)) return false;
	const firstLine = readFirstNonEmptyLine(filePath);
	if (!firstLine) return false;
	try {
		const parsed = JSON.parse(firstLine);
		return isRecord(parsed) && parsed.traceSchema === "openclaw-trajectory" && parsed.schemaVersion === 1 && parsed.source === "runtime" && parsed.sessionId === sessionId;
	} catch {
		return false;
	}
}
async function removeRegularFile(filePath, kind) {
	if (!isRegularNonSymlinkFile(filePath)) return null;
	await fs.promises.rm(filePath, { force: true });
	return {
		kind,
		path: path.resolve(filePath)
	};
}
function resolveRemovedSessionFile(params) {
	try {
		return resolveSessionFilePath(params.sessionId, params.sessionFile ? { sessionFile: params.sessionFile } : void 0, { sessionsDir: path.dirname(params.storePath) });
	} catch {
		return null;
	}
}
function mayRemoveRuntimeTarget(params) {
	const resolved = canonicalizePathForComparison(params.filePath);
	const withinStoreDir = isPathWithinDir(params.storeDir, resolved);
	if (canonicalizePathForComparison(params.defaultRuntimePath) === resolved) return !params.restrictToStoreDir || withinStoreDir;
	if (params.restrictToStoreDir && withinStoreDir) return true;
	const expectedName = `${safeTrajectorySessionFileName(params.sessionId)}.jsonl`;
	if (path.basename(resolved) !== expectedName) return false;
	return runtimeFileStartsWithSessionEvent(resolved, params.sessionId);
}
async function removeSessionTrajectoryArtifacts(params) {
	const sessionFile = resolveRemovedSessionFile(params);
	if (!sessionFile) return [];
	const storeDir = path.dirname(path.resolve(params.storePath));
	const restrictToStoreDir = params.restrictToStoreDir === true;
	const removed = [];
	const pointerPath = resolveTrajectoryPointerFilePath(sessionFile);
	const pointer = readTrajectoryPointerFile(pointerPath, params.sessionId);
	const defaultRuntimePath = resolveTrajectoryFilePath({
		env: {},
		sessionFile,
		sessionId: params.sessionId
	});
	const runtimeCandidates = new Set([defaultRuntimePath]);
	if (pointer?.runtimeFile) runtimeCandidates.add(pointer.runtimeFile);
	for (const runtimePath of runtimeCandidates) {
		if (!mayRemoveRuntimeTarget({
			defaultRuntimePath,
			filePath: runtimePath,
			sessionId: params.sessionId,
			storeDir,
			restrictToStoreDir
		})) continue;
		const deleted = await removeRegularFile(runtimePath, "runtime");
		if (deleted) removed.push(deleted);
	}
	if (!restrictToStoreDir || isPathWithinDir(storeDir, pointerPath)) {
		const deletedPointer = await removeRegularFile(pointerPath, "pointer");
		if (deletedPointer) removed.push(deletedPointer);
	}
	return removed;
}
async function removeRemovedSessionTrajectoryArtifacts(params) {
	const removed = [];
	for (const [sessionId, sessionFile] of params.removedSessionFiles) {
		if (params.referencedSessionIds.has(sessionId)) continue;
		removed.push(...await removeSessionTrajectoryArtifacts({
			sessionId,
			sessionFile,
			storePath: params.storePath,
			restrictToStoreDir: params.restrictToStoreDir
		}));
	}
	return removed;
}
//#endregion
export { removeRemovedSessionTrajectoryArtifacts, removeSessionTrajectoryArtifacts };
