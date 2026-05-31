//#region src/session-lineage-meta.d.ts
declare const SUBAGENT_ROLES: readonly ["orchestrator", "leaf"];
declare const SUBAGENT_CONTROL_SCOPES: readonly ["children", "none"];
type SubagentRole = (typeof SUBAGENT_ROLES)[number];
type SubagentControlScope = (typeof SUBAGENT_CONTROL_SCOPES)[number];
type AcpSessionLineageMeta = {
  sessionKey: string;
  kind?: string;
  channel?: string;
  parentSessionId?: string;
  spawnedBy?: string;
  spawnDepth?: number;
  subagentRole?: SubagentRole;
  subagentControlScope?: SubagentControlScope;
  spawnedWorkspaceDir?: string;
  spawnedCwd?: string;
};
type AcpSessionLineageRow = {
  key: string;
  kind?: string;
  channel?: string;
  parentSessionKey?: string;
  spawnedBy?: string;
  spawnDepth?: number;
  subagentRole?: string;
  subagentControlScope?: string;
  spawnedWorkspaceDir?: string;
  spawnedCwd?: string;
};
declare function toAcpSessionLineageMeta(row: AcpSessionLineageRow): AcpSessionLineageMeta;
//#endregion
export { AcpSessionLineageMeta, AcpSessionLineageRow, toAcpSessionLineageMeta };