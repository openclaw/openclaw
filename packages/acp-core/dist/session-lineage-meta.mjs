import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
//#region src/session-lineage-meta.ts
const SUBAGENT_ROLES = ["orchestrator", "leaf"];
const SUBAGENT_CONTROL_SCOPES = ["children", "none"];
function readInteger(value) {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return;
	return value;
}
function readEnum(value, allowed) {
	const normalized = normalizeOptionalString(value);
	return allowed.find((candidate) => candidate === normalized);
}
function toAcpSessionLineageMeta(row) {
	const sessionKey = normalizeOptionalString(row.key) ?? row.key;
	const kind = normalizeOptionalString(row.kind);
	const channel = normalizeOptionalString(row.channel);
	const parentSessionId = normalizeOptionalString(row.parentSessionKey) ?? normalizeOptionalString(row.spawnedBy);
	const spawnedBy = normalizeOptionalString(row.spawnedBy);
	const spawnDepth = readInteger(row.spawnDepth);
	const subagentRole = readEnum(row.subagentRole, SUBAGENT_ROLES);
	const subagentControlScope = readEnum(row.subagentControlScope, SUBAGENT_CONTROL_SCOPES);
	const spawnedWorkspaceDir = normalizeOptionalString(row.spawnedWorkspaceDir);
	const spawnedCwd = normalizeOptionalString(row.spawnedCwd);
	return {
		sessionKey,
		...kind ? { kind } : {},
		...channel ? { channel } : {},
		...parentSessionId ? { parentSessionId } : {},
		...spawnedBy ? { spawnedBy } : {},
		...spawnDepth !== void 0 ? { spawnDepth } : {},
		...subagentRole ? { subagentRole } : {},
		...subagentControlScope ? { subagentControlScope } : {},
		...spawnedWorkspaceDir ? { spawnedWorkspaceDir } : {},
		...spawnedCwd ? { spawnedCwd } : {}
	};
}
//#endregion
export { toAcpSessionLineageMeta };
