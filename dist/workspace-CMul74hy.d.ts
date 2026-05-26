//#region src/agents/workspace.d.ts
declare const DEFAULT_AGENTS_FILENAME = "AGENTS.md";
declare const DEFAULT_SOUL_FILENAME = "SOUL.md";
declare const DEFAULT_TOOLS_FILENAME = "TOOLS.md";
declare const DEFAULT_IDENTITY_FILENAME = "IDENTITY.md";
declare const DEFAULT_USER_FILENAME = "USER.md";
declare const DEFAULT_HEARTBEAT_FILENAME = "HEARTBEAT.md";
declare const DEFAULT_BOOTSTRAP_FILENAME = "BOOTSTRAP.md";
declare const DEFAULT_MEMORY_FILENAME = "MEMORY.md";
type WorkspaceBootstrapFileName = typeof DEFAULT_AGENTS_FILENAME | typeof DEFAULT_SOUL_FILENAME | typeof DEFAULT_TOOLS_FILENAME | typeof DEFAULT_IDENTITY_FILENAME | typeof DEFAULT_USER_FILENAME | typeof DEFAULT_HEARTBEAT_FILENAME | typeof DEFAULT_BOOTSTRAP_FILENAME | typeof DEFAULT_MEMORY_FILENAME;
type WorkspaceBootstrapFile = {
  name: WorkspaceBootstrapFileName;
  path: string;
  content?: string;
  missing: boolean;
};
declare function ensureAgentWorkspace(params?: {
  dir?: string;
  ensureBootstrapFiles?: boolean;
  /**
   * List of optional bootstrap filenames to skip writing.
   * Applies only to SOUL.md, USER.md, HEARTBEAT.md, IDENTITY.md.
   * Required workspace setup such as AGENTS.md and TOOLS.md still runs.
   */
  skipOptionalBootstrapFiles?: string[];
}): Promise<{
  dir: string;
  agentsPath?: string;
  soulPath?: string;
  toolsPath?: string;
  identityPath?: string;
  userPath?: string;
  heartbeatPath?: string;
  bootstrapPath?: string;
  identityPathCreated?: boolean;
}>;
//#endregion
export { ensureAgentWorkspace as n, WorkspaceBootstrapFile as t };