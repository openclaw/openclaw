// Shared callable contract for compiled callers loading source-checkout writers.
type PreparedBundledPluginRuntime = {
  changed: boolean;
  publish(assertCurrent: () => void | Promise<void>): Promise<void>;
  cleanup(): Promise<void>;
};

export type PrepareBundledPluginRuntime = (params: {
  repoRoot: string;
}) => PreparedBundledPluginRuntime;

export type DistArtifactParentBinding = Readonly<{
  pid: number;
  digest?: string;
  lifetime?: "process";
}>;

export type DistArtifactEntryOptions = {
  native?: boolean;
  rootDir?: string;
  parent?: DistArtifactParentBinding;
};

export type DistArtifactEntryArgs = (
  script: string,
  args?: string[],
  options?: DistArtifactEntryOptions,
) => string[];

export type WithDistArtifactOwnership = <T>(
  rootDir: string,
  run: (ownership?: DistArtifactOwnership) => Promise<T>,
) => Promise<T>;

export type DistArtifactOwnership = {
  assertOwned(): Promise<void>;
  release(): Promise<void>;
  entryArgs(script: string, args?: string[]): Promise<string[]>;
  /** Cleanup could not confirm child settlement, including before its claim appeared. */
  retainUnjoined(): void;
  /** Only after the process owner joins the child tree and verifies its result. */
  completeChild(pid: number): Promise<void>;
};

export type AcquireDistArtifactOwnership = (
  rootDir: string,
  options?: { wait?: boolean; runtimeChildren?: boolean },
) => Promise<DistArtifactOwnership>;
