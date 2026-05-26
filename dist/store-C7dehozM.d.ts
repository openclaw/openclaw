import { O as SessionMaintenanceMode } from "./types.base-DCoxbfrn.js";
import { t as DeliveryContext } from "./delivery-context.types-z_8oTfxq.js";
import { o as SessionEntry, r as GroupKeyResolution } from "./types-D2DuU_TB.js";
import { n as MsgContext } from "./templating-BcdAlwzB.js";

//#region src/config/sessions/paths.d.ts
declare function resolveSessionTranscriptsDirForAgent(agentId?: string, env?: NodeJS.ProcessEnv, homedir?: () => string): string;
type SessionFilePathOptions = {
  agentId?: string;
  sessionsDir?: string;
};
declare function resolveSessionTranscriptPathInDir(sessionId: string, sessionsDir: string, topicId?: string | number): string;
declare function resolveSessionFilePath(sessionId: string, entry?: {
  sessionFile?: string;
}, opts?: SessionFilePathOptions): string;
declare function resolveStorePath(store?: string, opts?: {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
}): string;
//#endregion
//#region src/config/sessions/store-maintenance.d.ts
type SessionMaintenanceWarning = {
  activeSessionKey: string;
  activeUpdatedAt?: number;
  totalEntries: number;
  pruneAfterMs: number;
  maxEntries: number;
  wouldPrune: boolean;
  wouldCap: boolean;
};
type ResolvedSessionMaintenanceConfig = {
  mode: SessionMaintenanceMode;
  pruneAfterMs: number;
  maxEntries: number;
  resetArchiveRetentionMs: number | null;
  maxDiskBytes: number | null;
  highWaterBytes: number | null;
};
//#endregion
//#region src/config/sessions/store-load.d.ts
type LoadSessionStoreOptions = {
  skipCache?: boolean;
  maintenanceConfig?: ResolvedSessionMaintenanceConfig;
  runMaintenance?: boolean;
  clone?: boolean;
};
declare function loadSessionStore(storePath: string, opts?: LoadSessionStoreOptions): Record<string, SessionEntry>;
//#endregion
//#region src/config/sessions/disk-budget.d.ts
type SessionDiskBudgetSweepResult = {
  totalBytesBefore: number;
  totalBytesAfter: number;
  removedFiles: number;
  removedEntries: number;
  freedBytes: number;
  maxBytes: number;
  highWaterBytes: number;
  overBudget: boolean;
};
//#endregion
//#region src/config/sessions/store-writer-state.d.ts
declare function clearSessionStoreCacheForTest(): void;
//#endregion
//#region src/config/sessions/store-entry.d.ts
declare function resolveSessionStoreEntry(params: {
  store: Record<string, SessionEntry>;
  sessionKey: string;
}): {
  normalizedKey: string;
  existing: SessionEntry | undefined;
  legacyKeys: string[];
};
//#endregion
//#region src/config/sessions/store.d.ts
declare function readSessionUpdatedAt(params: {
  storePath: string;
  sessionKey: string;
}): number | undefined;
type SessionMaintenanceApplyReport = {
  mode: ResolvedSessionMaintenanceConfig["mode"];
  beforeCount: number;
  afterCount: number;
  pruned: number;
  capped: number;
  diskBudget: SessionDiskBudgetSweepResult | null;
};
type SaveSessionStoreOptions = {
  /** Skip pruning, capping, and rotation (e.g. during one-time migrations). */skipMaintenance?: boolean; /** Active session key for warn-only maintenance. */
  activeSessionKey?: string;
  /**
   * Session keys that are allowed to drop persisted ACP metadata during this update.
   * All other updates preserve existing `entry.acp` blocks when callers replace the
   * whole session entry without carrying ACP state forward.
   */
  allowDropAcpMetaSessionKeys?: string[]; /** Optional callback for warn-only maintenance. */
  onWarn?: (warning: SessionMaintenanceWarning) => void | Promise<void>; /** Optional callback with maintenance stats after a save. */
  onMaintenanceApplied?: (report: SessionMaintenanceApplyReport) => void | Promise<void>; /** Optional overrides used by maintenance commands. */
  maintenanceOverride?: Partial<ResolvedSessionMaintenanceConfig>; /** Fully resolved maintenance settings when the caller already has config loaded. */
  maintenanceConfig?: ResolvedSessionMaintenanceConfig;
};
declare function saveSessionStore(storePath: string, store: Record<string, SessionEntry>, opts?: SaveSessionStoreOptions): Promise<void>;
declare function updateSessionStore<T>(storePath: string, mutator: (store: Record<string, SessionEntry>) => Promise<T> | T, opts?: SaveSessionStoreOptions): Promise<T>;
declare function updateSessionStoreEntry(params: {
  storePath: string;
  sessionKey: string;
  update: (entry: SessionEntry) => Promise<Partial<SessionEntry> | null>;
}): Promise<SessionEntry | null>;
declare function recordSessionMetaFromInbound(params: {
  storePath: string;
  sessionKey: string;
  ctx: MsgContext;
  groupResolution?: GroupKeyResolution | null;
  createIfMissing?: boolean;
}): Promise<SessionEntry | null>;
declare function updateLastRoute(params: {
  storePath: string;
  sessionKey: string;
  channel?: SessionEntry["lastChannel"];
  to?: string;
  accountId?: string;
  threadId?: string | number;
  deliveryContext?: DeliveryContext;
  ctx?: MsgContext;
  groupResolution?: GroupKeyResolution | null;
  createIfMissing?: boolean;
}): Promise<SessionEntry | null>;
//#endregion
export { updateSessionStore as a, clearSessionStoreCacheForTest as c, resolveSessionFilePath as d, resolveSessionTranscriptPathInDir as f, updateLastRoute as i, loadSessionStore as l, resolveStorePath as m, recordSessionMetaFromInbound as n, updateSessionStoreEntry as o, resolveSessionTranscriptsDirForAgent as p, saveSessionStore as r, resolveSessionStoreEntry as s, readSessionUpdatedAt as t, ResolvedSessionMaintenanceConfig as u };