export type ChangedScope = {
  runNode: boolean;
  runChannels: boolean;
  runMacos: boolean;
  runMacosNative: boolean;
  runAndroid: boolean;
  runWindows: boolean;
  runSkillsPython: boolean;
};

export function detectChangedScope(changedPaths: string[]): ChangedScope;
export function listChangedPaths(base: string, head?: string): string[];
export function writeGitHubOutput(scope: ChangedScope, outputPath?: string): void;
