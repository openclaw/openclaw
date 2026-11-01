type ChangedScope = {
  runNode: boolean;
  runMacos: boolean;
  runMacosNode: boolean;
  runIosBuild: boolean;
  runAndroid: boolean;
  runWindows: boolean;
  runSkillsPython: boolean;
  runControlUiI18n: boolean;
  runUiTests: boolean;
};
type NodeFastScope = {
  runFastOnly: boolean;
  runPluginContracts: boolean;
  runCiRouting: boolean;
};
export function isCiDocumentationPath(changedPath: string): boolean;
export function isNodeTestDataOnlyPath(changedPath: string): boolean;
export function isIndependentlyCheckedDocumentation(changedPath: string, cwd: string): boolean;
export function resolveReleaseFastLaneScope(
  changedPaths: readonly string[] | null,
  options?: { cwd?: string },
): { eligible: true } | { eligible: false; reason: string };
export function isMacosToolingPath(path: string): boolean;
export function detectChangedScope(changedPaths: string[]): ChangedScope;
export function shouldRunIosScreenshots(changedPaths: string[] | null): boolean;
export function assertControlUiGeneratedArtifactsIsolated(
  changedPaths: string[],
  branchName?: string,
): void;
export function shouldStrictControlUiI18n(changedPaths: string[] | null): boolean;
export function assertNativeGeneratedArtifactsIsolated(
  changedPaths: string[],
  branchName?: string,
): void;
export function shouldStrictNativeI18n(changedPaths: string[] | null): boolean;
export function resolveAllowedGeneratedMixBranch(
  env?: Readonly<Record<string, string | undefined>>,
  branchName?: string,
): string;
export function hasMlxNativeProofInputs(changedPaths: readonly string[] | null): boolean;
export function shouldRunNativeI18n(changedPaths: string[] | null | undefined): boolean;
export function detectNodeFastScope(changedPaths: string[]): NodeFastScope;
export function listChangedPaths(
  base: string,
  head?: string,
  cwd?: string,
  preferMergeHeadFirstParent?: boolean,
): string[];
export function writeGitHubOutput(
  scope: ChangedScope,
  outputPath?: string,
  nodeFastScope?: NodeFastScope,
  runNativeI18n?: boolean,
  changedPaths?: string[] | null,
  workflowEventName?: string,
): void;
export function parseArgs(argv: string[]): {
  base: string;
  head: string;
  mergeHeadFirstParent: boolean;
};
