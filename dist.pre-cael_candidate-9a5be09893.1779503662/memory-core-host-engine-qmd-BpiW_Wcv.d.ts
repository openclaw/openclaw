import { n as ResolvedQmdConfig } from "./backend-config-sWi6OqWL.js";

//#region packages/memory-host-sdk/src/host/session-files.d.ts
type SessionFileEntry = {
  path: string;
  absPath: string;
  mtimeMs: number;
  size: number;
  hash: string;
  content: string; /** Maps each content line (0-indexed) to its 1-indexed JSONL source line. */
  lineMap: number[]; /** Maps each content line (0-indexed) to epoch ms; 0 means unknown timestamp. */
  messageTimestampsMs: number[]; /** True when this transcript belongs to an internal dreaming narrative run. */
  generatedByDreamingNarrative?: boolean; /** True when this transcript belongs to an isolated cron run session. */
  generatedByCronRun?: boolean;
};
type BuildSessionEntryOptions = {
  /** Optional preclassification from a caller-managed dreaming transcript lookup. */generatedByDreamingNarrative?: boolean; /** Optional preclassification from a caller-managed cron transcript lookup. */
  generatedByCronRun?: boolean; /** Override for tests or specialized callers that need a tighter parse yield cadence. */
  parseYieldEveryLines?: number;
};
type SessionTranscriptClassification = {
  dreamingNarrativeTranscriptPaths: ReadonlySet<string>;
  cronRunTranscriptPaths: ReadonlySet<string>;
};
declare function normalizeSessionTranscriptPathForComparison(pathname: string): string;
declare function loadDreamingNarrativeTranscriptPathSetForAgent(agentId: string): ReadonlySet<string>;
declare function loadSessionTranscriptClassificationForAgent(agentId: string): SessionTranscriptClassification;
declare function listSessionFilesForAgent(agentId: string): Promise<string[]>;
declare function sessionPathForFile(absPath: string): string;
declare function buildSessionEntry(absPath: string, opts?: BuildSessionEntryOptions): Promise<SessionFileEntry | null>;
//#endregion
//#region packages/memory-host-sdk/src/host/qmd-query-parser.d.ts
type QmdQueryResult = {
  docid?: string;
  score?: number;
  collection?: string;
  file?: string;
  snippet?: string;
  body?: string;
  startLine?: number;
  endLine?: number;
};
declare function parseQmdQueryJson(stdout: string, stderr: string): QmdQueryResult[];
//#endregion
//#region packages/memory-host-sdk/src/host/qmd-scope.d.ts
declare function isQmdScopeAllowed(scope: ResolvedQmdConfig["scope"], sessionKey?: string): boolean;
declare function deriveQmdScopeChannel(key?: string): string | undefined;
declare function deriveQmdScopeChatType(key?: string): "channel" | "group" | "direct" | undefined;
//#endregion
//#region packages/memory-host-sdk/src/host/qmd-process.d.ts
type CliSpawnInvocation = {
  command: string;
  argv: string[];
  shell?: boolean;
  windowsHide?: boolean;
};
type QmdBinaryUnavailableReason = "binary" | "workspace-cwd";
type QmdBinaryUnavailable = {
  available: false;
  /**
   * Optional for source compatibility with older plugin SDK callers that
   * returned only `{ available: false, error }`.
   */
  reason?: QmdBinaryUnavailableReason;
  error: string;
};
type QmdBinaryAvailability = {
  available: true;
} | QmdBinaryUnavailable;
declare function resolveQmdBinaryUnavailableReason(result: QmdBinaryUnavailable): QmdBinaryUnavailableReason;
declare function resolveCliSpawnInvocation(params: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  packageName: string;
}): CliSpawnInvocation;
declare function checkQmdBinaryAvailability(params: {
  command: string;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
}): Promise<QmdBinaryAvailability>;
declare function runCliCommand(params: {
  commandSummary: string;
  spawnInvocation: CliSpawnInvocation;
  env: NodeJS.ProcessEnv;
  cwd: string;
  timeoutMs?: number;
  maxOutputChars: number;
  discardStdout?: boolean;
}): Promise<{
  stdout: string;
  stderr: string;
}>;
//#endregion
export { listSessionFilesForAgent as _, resolveCliSpawnInvocation as a, normalizeSessionTranscriptPathForComparison as b, deriveQmdScopeChannel as c, QmdQueryResult as d, parseQmdQueryJson as f, buildSessionEntry as g, SessionTranscriptClassification as h, checkQmdBinaryAvailability as i, deriveQmdScopeChatType as l, SessionFileEntry as m, QmdBinaryUnavailable as n, resolveQmdBinaryUnavailableReason as o, BuildSessionEntryOptions as p, QmdBinaryUnavailableReason as r, runCliCommand as s, QmdBinaryAvailability as t, isQmdScopeAllowed as u, loadDreamingNarrativeTranscriptPathSetForAgent as v, sessionPathForFile as x, loadSessionTranscriptClassificationForAgent as y };