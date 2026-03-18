export function collectBundledProviderAuthEnvVars(params?: {
  repoRoot?: string;
}): Record<string, readonly string[]>;

export function renderBundledProviderAuthEnvVarModule(
  entries: Record<string, readonly string[]>,
): string;

export function writeBundledProviderAuthEnvVarModule(params?: {
  repoRoot?: string;
  outputPath?: string;
  check?: boolean;
}): {
  changed: boolean;
  wrote: boolean;
  outputPath: string;
};
