//#region extensions/migrate-claude/source.d.ts
type ClaudeArchivePath = {
  id: string;
  path: string;
  relativePath: string;
};
type ClaudeSource = {
  root: string;
  confidence: "low" | "medium" | "high";
  homeDir?: string;
  projectDir?: string;
  homeProjectsDir?: string;
  userSettingsPath?: string;
  userLocalSettingsPath?: string;
  userClaudeJsonPath?: string;
  userMemoryPath?: string;
  projectSettingsPath?: string;
  projectLocalSettingsPath?: string;
  projectMcpPath?: string;
  projectMemoryPath?: string;
  projectDotClaudeMemoryPath?: string;
  projectLocalMemoryPath?: string;
  projectRulesDir?: string;
  userSkillsDir?: string;
  projectSkillsDir?: string;
  userCommandsDir?: string;
  projectCommandsDir?: string;
  userAgentsDir?: string;
  projectAgentsDir?: string;
  desktopConfigPath?: string;
  archivePaths: ClaudeArchivePath[];
};
declare function discoverClaudeSource(input?: string): Promise<ClaudeSource>;
declare function hasClaudeSource(source: ClaudeSource): boolean;
//#endregion
export { discoverClaudeSource as n, hasClaudeSource as r, ClaudeSource as t };