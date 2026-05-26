import { V as MemoryReadResult } from "./memory-state-CSqCMoFA.js";
import { a as OpenClawConfig } from "./backend-config-sWi6OqWL.js";

//#region packages/memory-host-sdk/src/host/read-file-shared.d.ts
declare const DEFAULT_MEMORY_READ_LINES = 120;
declare const DEFAULT_MEMORY_READ_MAX_CHARS = 12000;
declare function buildMemoryReadResultFromSlice(params: {
  selectedLines: string[];
  relPath: string;
  startLine: number;
  moreSourceLinesRemain?: boolean;
  maxChars?: number;
  suggestReadFallback?: boolean;
}): MemoryReadResult;
declare function buildMemoryReadResult(params: {
  content: string;
  relPath: string;
  from?: number;
  lines?: number;
  defaultLines?: number;
  maxChars?: number;
  suggestReadFallback?: boolean;
}): MemoryReadResult;
//#endregion
//#region packages/memory-host-sdk/src/host/read-file.d.ts
declare function readMemoryFile(params: {
  workspaceDir: string;
  extraPaths?: string[];
  relPath: string;
  from?: number;
  lines?: number;
  defaultLines?: number;
  maxChars?: number;
}): Promise<MemoryReadResult>;
declare function readAgentMemoryFile(params: {
  cfg: OpenClawConfig;
  agentId: string;
  relPath: string;
  from?: number;
  lines?: number;
}): Promise<MemoryReadResult>;
//#endregion
export { buildMemoryReadResult as a, DEFAULT_MEMORY_READ_MAX_CHARS as i, readMemoryFile as n, buildMemoryReadResultFromSlice as o, DEFAULT_MEMORY_READ_LINES as r, readAgentMemoryFile as t };