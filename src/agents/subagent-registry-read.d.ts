import type { SubagentRunRecord } from "./subagent-registry.types.js";
export { getSubagentSessionRuntimeMs, getSubagentSessionStartedAt, resolveSubagentSessionStatus, } from "./subagent-session-metrics.js";
export declare function listSubagentRunsForController(controllerSessionKey: string): SubagentRunRecord[];
export declare function countActiveDescendantRuns(rootSessionKey: string): number;
export declare function listDescendantRunsForRequester(rootSessionKey: string): SubagentRunRecord[];
export declare function getSubagentRunByChildSessionKey(childSessionKey: string): SubagentRunRecord | null;
export declare function isSubagentRunLive(entry: Pick<SubagentRunRecord, "runId" | "endedAt"> | null | undefined): boolean;
export declare function getSessionDisplaySubagentRunByChildSessionKey(childSessionKey: string): SubagentRunRecord | null;
export declare function getLatestSubagentRunByChildSessionKey(childSessionKey: string): SubagentRunRecord | null;
