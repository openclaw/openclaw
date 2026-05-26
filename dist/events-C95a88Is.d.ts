import { q as MemoryDreamingPhaseName } from "./dreaming-B-5AZJCw.js";

//#region src/memory-host-sdk/events.d.ts
declare const MEMORY_HOST_EVENT_LOG_RELATIVE_PATH: string;
type MemoryHostRecallRecordedEvent = {
  type: "memory.recall.recorded";
  timestamp: string;
  query: string;
  resultCount: number;
  results: Array<{
    path: string;
    startLine: number;
    endLine: number;
    score: number;
  }>;
};
type MemoryHostPromotionAppliedEvent = {
  type: "memory.promotion.applied";
  timestamp: string;
  memoryPath: string;
  applied: number;
  candidates: Array<{
    key: string;
    path: string;
    startLine: number;
    endLine: number;
    score: number;
    recallCount: number;
  }>;
};
type MemoryHostDreamCompletedEvent = {
  type: "memory.dream.completed";
  timestamp: string;
  phase: MemoryDreamingPhaseName;
  inlinePath?: string;
  reportPath?: string;
  lineCount: number;
  storageMode: "inline" | "separate" | "both";
};
type MemoryHostEvent = MemoryHostRecallRecordedEvent | MemoryHostPromotionAppliedEvent | MemoryHostDreamCompletedEvent;
declare function resolveMemoryHostEventLogPath(workspaceDir: string): string;
declare function appendMemoryHostEvent(workspaceDir: string, event: MemoryHostEvent): Promise<void>;
declare function readMemoryHostEvents(params: {
  workspaceDir: string;
  limit?: number;
}): Promise<MemoryHostEvent[]>;
//#endregion
export { MemoryHostRecallRecordedEvent as a, resolveMemoryHostEventLogPath as c, MemoryHostPromotionAppliedEvent as i, MemoryHostDreamCompletedEvent as n, appendMemoryHostEvent as o, MemoryHostEvent as r, readMemoryHostEvents as s, MEMORY_HOST_EVENT_LOG_RELATIVE_PATH as t };