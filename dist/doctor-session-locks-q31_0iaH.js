import { v as resolveStateDir } from "./paths-Cnwfh6dH.js";
import { g as shortenHomePath } from "./utils-CKsuXgDI.js";
import { t as resolveAgentSessionDirs } from "./session-dirs-DO_2hW-1.js";
import { i as cleanStaleLockFiles } from "./session-write-lock-BT1vMcpZ.js";
import { t as note } from "./note-Bg5THHEx.js";
//#region src/commands/doctor-session-locks.ts
const DEFAULT_STALE_MS = 1800 * 1e3;
function formatAge(ageMs) {
	if (ageMs === null) return "unknown";
	const seconds = Math.floor(ageMs / 1e3);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	if (minutes < 60) return `${minutes}m${remainingSeconds}s`;
	return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}
function formatLockLine(lock) {
	const pidStatus = lock.pid === null ? "pid=missing" : `pid=${lock.pid} (${lock.pidAlive ? "alive" : "dead"})`;
	const ageStatus = `age=${formatAge(lock.ageMs)}`;
	const staleStatus = lock.stale ? `stale=yes (${lock.staleReasons.join(", ") || "unknown"})` : "stale=no";
	const removedStatus = lock.removed ? " [removed]" : "";
	return `- ${shortenHomePath(lock.lockPath)} ${pidStatus} ${ageStatus} ${staleStatus}${removedStatus}`;
}
async function noteSessionLockHealth(params) {
	const shouldRepair = params?.shouldRepair === true;
	const staleMs = params?.staleMs ?? DEFAULT_STALE_MS;
	let sessionDirs = [];
	try {
		sessionDirs = await resolveAgentSessionDirs(resolveStateDir(process.env));
	} catch (err) {
		note(`- Failed to inspect session lock files: ${String(err)}`, "Session locks");
		return;
	}
	if (sessionDirs.length === 0) return;
	const allLocks = [];
	for (const sessionsDir of sessionDirs) {
		const result = await cleanStaleLockFiles({
			sessionsDir,
			staleMs,
			removeStale: shouldRepair,
			readOwnerProcessArgs: params?.readOwnerProcessArgs
		});
		allLocks.push(...result.locks);
	}
	if (allLocks.length === 0) return;
	const staleCount = allLocks.filter((lock) => lock.stale).length;
	const removedCount = allLocks.filter((lock) => lock.removed).length;
	const lines = [`- Found ${allLocks.length} session lock file${allLocks.length === 1 ? "" : "s"}.`, ...allLocks.toSorted((a, b) => a.lockPath.localeCompare(b.lockPath)).map(formatLockLine)];
	if (staleCount > 0 && !shouldRepair) {
		lines.push(`- ${staleCount} lock file${staleCount === 1 ? " is" : "s are"} stale.`);
		lines.push("- Run \"openclaw doctor --fix\" to remove stale lock files automatically.");
	}
	if (shouldRepair && removedCount > 0) lines.push(`- Removed ${removedCount} stale session lock file${removedCount === 1 ? "" : "s"}.`);
	note(lines.join("\n"), "Session locks");
}
//#endregion
export { noteSessionLockHealth };
