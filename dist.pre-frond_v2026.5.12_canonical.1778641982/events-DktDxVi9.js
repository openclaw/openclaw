import path from "node:path";
import fs from "node:fs/promises";
//#region src/memory-host-sdk/events.ts
const MEMORY_HOST_EVENT_LOG_RELATIVE_PATH = path.join("memory", ".dreams", "events.jsonl");
function resolveMemoryHostEventLogPath(workspaceDir) {
	return path.join(workspaceDir, MEMORY_HOST_EVENT_LOG_RELATIVE_PATH);
}
async function appendMemoryHostEvent(workspaceDir, event) {
	const eventLogPath = resolveMemoryHostEventLogPath(workspaceDir);
	await fs.mkdir(path.dirname(eventLogPath), { recursive: true });
	await fs.appendFile(eventLogPath, `${JSON.stringify(event)}\n`, "utf8");
}
async function readMemoryHostEvents(params) {
	const eventLogPath = resolveMemoryHostEventLogPath(params.workspaceDir);
	const raw = await fs.readFile(eventLogPath, "utf8").catch((err) => {
		if (err?.code === "ENOENT") return "";
		throw err;
	});
	if (!raw.trim()) return [];
	const events = raw.split("\n").map((line) => line.trim()).filter(Boolean).flatMap((line) => {
		try {
			return [JSON.parse(line)];
		} catch {
			return [];
		}
	});
	if (!Number.isFinite(params.limit)) return events;
	const limit = Math.max(0, Math.floor(params.limit));
	return limit === 0 ? [] : events.slice(-limit);
}
//#endregion
export { resolveMemoryHostEventLogPath as i, appendMemoryHostEvent as n, readMemoryHostEvents as r, MEMORY_HOST_EVENT_LOG_RELATIVE_PATH as t };
