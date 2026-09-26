// Shared callable contract for compiled callers loading source-checkout writers.
type PreparedBundledPluginRuntime = {
  changed: boolean;
  publish(assertCurrent: () => void | Promise<void>): Promise<void>;
  cleanup(): Promise<void>;
};

export type PrepareBundledPluginRuntime = (params: {
  repoRoot: string;
}) => PreparedBundledPluginRuntime;

export type WithDistArtifactOwnership = <T>(rootDir: string, run: () => Promise<T>) => Promise<T>;
