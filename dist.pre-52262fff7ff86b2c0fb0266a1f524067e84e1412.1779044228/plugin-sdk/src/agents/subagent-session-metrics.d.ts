import type { SubagentRunRecord } from "./subagent-registry.types.js";
export declare function getSubagentSessionStartedAt(entry: Pick<SubagentRunRecord, "sessionStartedAt" | "startedAt" | "createdAt"> | null | undefined): number | undefined;
export declare function getSubagentSessionRuntimeMs(entry: Pick<SubagentRunRecord, "startedAt" | "endedAt" | "accumulatedRuntimeMs"> | null | undefined, now?: number): number | undefined;
export declare function resolveSubagentSessionStatus(entry: Pick<SubagentRunRecord, "endedAt" | "endedReason" | "outcome"> | null | undefined): "running" | "killed" | "failed" | "timeout" | "done" | undefined;
