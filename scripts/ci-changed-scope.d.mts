export type ChangedScope = {
  runNode: boolean;
  runMacos: boolean;
  runIosBuild: boolean;
  runAndroid: boolean;
  runWindows: boolean;
  runSkillsPython: boolean;
  runChangedSmoke: boolean;
  runControlUiI18n: boolean;
};

export type InstallSmokeScope = {
  runFastInstallSmoke: boolean;
  runFullInstallSmoke: boolean;
};

export function detectChangedScope(changedPaths: string[]): ChangedScope;
export function shouldRunNativeI18n(changedPaths: string[]): boolean;
export function detectInstallSmokeScope(changedPaths: string[]): InstallSmokeScope;
export function listChangedPaths(
  base: string,
  head?: string,
  cwd?: string,
  preferMergeHeadFirstParent?: boolean,
): string[];
export function writeGitHubOutput(
  scope: ChangedScope,
  outputPath?: string,
  installSmokeScope?: InstallSmokeScope,
  nodeFastScope?: {
    runFastOnly: boolean;
    runPluginContracts: boolean;
    runCiRouting: boolean;
  },
  runNativeI18n?: boolean,
): void;
