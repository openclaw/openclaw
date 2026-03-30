// Real workspace contract for QMD/session/query helpers used by the memory engine.

export {
	checkQmdBinaryAvailability,
	resolveCliSpawnInvocation,
	runCliCommand,
} from "./host/qmd-process.js";
export {
	parseQmdQueryJson,
	type QmdQueryResult,
} from "./host/qmd-query-parser.js";
export {
	deriveQmdScopeChannel,
	deriveQmdScopeChatType,
	isQmdScopeAllowed,
} from "./host/qmd-scope.js";
export {
	extractKeywords,
	isQueryStopWordToken,
} from "./host/query-expansion.js";
export {
	buildSessionEntry,
	listSessionFilesForAgent,
	type SessionFileEntry,
	sessionPathForFile,
} from "./host/session-files.js";
