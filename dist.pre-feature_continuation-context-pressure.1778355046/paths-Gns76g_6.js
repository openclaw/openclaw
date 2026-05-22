import { r as resolveHomeRelativePath } from "./home-dir-g5LU3LmA.js";
import fs from "node:fs";
import path from "node:path";
//#region src/trajectory/paths.ts
const TRAJECTORY_RUNTIME_CAPTURE_MAX_BYTES = 10 * 1024 * 1024;
const TRAJECTORY_RUNTIME_FILE_MAX_BYTES = 50 * 1024 * 1024;
const TRAJECTORY_RUNTIME_EVENT_MAX_BYTES = 256 * 1024;
function safeTrajectorySessionFileName(sessionId) {
	const safe = sessionId.replaceAll(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
	return /[A-Za-z0-9]/u.test(safe) ? safe : "session";
}
function resolveTrajectoryPointerOpenFlags(constants = fs.constants) {
	const noFollow = constants.O_NOFOLLOW;
	return constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY | (typeof noFollow === "number" ? noFollow : 0);
}
function resolveContainedPath(baseDir, fileName) {
	const resolvedBase = path.resolve(baseDir);
	const resolvedFile = path.resolve(resolvedBase, fileName);
	const relative = path.relative(resolvedBase, resolvedFile);
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Trajectory file path escaped its configured directory");
	return resolvedFile;
}
function resolveTrajectoryFilePath(params) {
	const dirOverride = (params.env ?? process.env).OPENCLAW_TRAJECTORY_DIR?.trim();
	if (dirOverride) return resolveContainedPath(resolveHomeRelativePath(dirOverride), `${safeTrajectorySessionFileName(params.sessionId)}.jsonl`);
	if (!params.sessionFile) return path.join(process.cwd(), `${safeTrajectorySessionFileName(params.sessionId)}.trajectory.jsonl`);
	return params.sessionFile.endsWith(".jsonl") ? `${params.sessionFile.slice(0, -6)}.trajectory.jsonl` : `${params.sessionFile}.trajectory.jsonl`;
}
function resolveTrajectoryPointerFilePath(sessionFile) {
	return sessionFile.endsWith(".jsonl") ? `${sessionFile.slice(0, -6)}.trajectory-path.json` : `${sessionFile}.trajectory-path.json`;
}
//#endregion
export { resolveTrajectoryPointerFilePath as a, resolveTrajectoryFilePath as i, TRAJECTORY_RUNTIME_EVENT_MAX_BYTES as n, resolveTrajectoryPointerOpenFlags as o, TRAJECTORY_RUNTIME_FILE_MAX_BYTES as r, safeTrajectorySessionFileName as s, TRAJECTORY_RUNTIME_CAPTURE_MAX_BYTES as t };
