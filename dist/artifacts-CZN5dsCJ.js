//#region src/config/sessions/artifacts.ts
const ARCHIVE_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d{3})?Z$/;
const LEGACY_STORE_BACKUP_RE = /^sessions\.json\.bak\.\d+$/;
const COMPACTION_CHECKPOINT_TRANSCRIPT_RE = /^(.+)\.checkpoint\.([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.jsonl$/i;
function hasArchiveSuffix(fileName, reason) {
	const marker = `.${reason}.`;
	const index = fileName.lastIndexOf(marker);
	if (index < 0) return false;
	const raw = fileName.slice(index + marker.length);
	return ARCHIVE_TIMESTAMP_RE.test(raw);
}
function isSessionArchiveArtifactName(fileName) {
	if (LEGACY_STORE_BACKUP_RE.test(fileName)) return true;
	return hasArchiveSuffix(fileName, "deleted") || hasArchiveSuffix(fileName, "reset") || hasArchiveSuffix(fileName, "bak");
}
function parseCompactionCheckpointTranscriptFileName(fileName) {
	const match = COMPACTION_CHECKPOINT_TRANSCRIPT_RE.exec(fileName);
	const sessionId = match?.[1];
	const checkpointId = match?.[2];
	return sessionId && checkpointId ? {
		sessionId,
		checkpointId
	} : null;
}
function isCompactionCheckpointTranscriptFileName(fileName) {
	return parseCompactionCheckpointTranscriptFileName(fileName) !== null;
}
function isTrajectoryRuntimeArtifactName(fileName) {
	return fileName.endsWith(".trajectory.jsonl");
}
function isTrajectoryPointerArtifactName(fileName) {
	return fileName.endsWith(".trajectory-path.json");
}
function isTrajectorySessionArtifactName(fileName) {
	return isTrajectoryRuntimeArtifactName(fileName) || isTrajectoryPointerArtifactName(fileName);
}
function isPrimarySessionTranscriptFileName(fileName) {
	if (fileName === "sessions.json") return false;
	if (!fileName.endsWith(".jsonl")) return false;
	if (isTrajectoryRuntimeArtifactName(fileName)) return false;
	if (isCompactionCheckpointTranscriptFileName(fileName)) return false;
	return !isSessionArchiveArtifactName(fileName);
}
function isUsageCountedSessionTranscriptFileName(fileName) {
	if (isPrimarySessionTranscriptFileName(fileName)) return true;
	return hasArchiveSuffix(fileName, "reset") || hasArchiveSuffix(fileName, "deleted");
}
function parseUsageCountedSessionIdFromFileName(fileName) {
	if (isPrimarySessionTranscriptFileName(fileName)) return fileName.slice(0, -6);
	for (const reason of ["reset", "deleted"]) {
		const marker = `.jsonl.${reason}.`;
		const index = fileName.lastIndexOf(marker);
		if (index > 0 && hasArchiveSuffix(fileName, reason)) return fileName.slice(0, index);
	}
	return null;
}
function formatSessionArchiveTimestamp(nowMs = Date.now()) {
	return new Date(nowMs).toISOString().replaceAll(":", "-");
}
function restoreSessionArchiveTimestamp(raw) {
	const [datePart, timePart] = raw.split("T");
	if (!datePart || !timePart) return raw;
	return `${datePart}T${timePart.replace(/-/g, ":")}`;
}
function parseSessionArchiveTimestamp(fileName, reason) {
	const marker = `.${reason}.`;
	const index = fileName.lastIndexOf(marker);
	if (index < 0) return null;
	const raw = fileName.slice(index + marker.length);
	if (!raw) return null;
	if (!ARCHIVE_TIMESTAMP_RE.test(raw)) return null;
	const timestamp = Date.parse(restoreSessionArchiveTimestamp(raw));
	return Number.isNaN(timestamp) ? null : timestamp;
}
//#endregion
export { isTrajectoryPointerArtifactName as a, isUsageCountedSessionTranscriptFileName as c, parseUsageCountedSessionIdFromFileName as d, isSessionArchiveArtifactName as i, parseCompactionCheckpointTranscriptFileName as l, isCompactionCheckpointTranscriptFileName as n, isTrajectoryRuntimeArtifactName as o, isPrimarySessionTranscriptFileName as r, isTrajectorySessionArtifactName as s, formatSessionArchiveTimestamp as t, parseSessionArchiveTimestamp as u };
