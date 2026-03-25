export type ChangedScope = {
  runNode: boolean;
  runMacos: boolean;
  runAndroid: boolean;
  runWindows: boolean;
  runSkillsPython: boolean;
  runChangedSmoke: boolean;
};

export function detectChangedScope(changedPaths: string[]): ChangedScope;
export function listChangedPaths(base: string, head?: string): string[];
export function writeGitHubOutput(scope: ChangedScope, outputPath?: string): void;
