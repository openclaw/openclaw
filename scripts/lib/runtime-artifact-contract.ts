// Shared callable contract for compiled callers loading source-checkout writers.
import type { FileLockHandle } from "@openclaw/fs-safe/file-lock";

/** Private owner operations lent only to the fixed native artifact implementation. */
export type NativeArtifactOwner = {
  custodyId: string;
  lock: FileLockHandle;
  admitNativeRoot: (pid: number, startIdentity: number) => Promise<string>;
  recordNativeSettlement(): Promise<void>;
};
type PreparedBundledPluginRuntime = {
  changed: boolean;
  publish(assertCurrent: () => void | Promise<void>): Promise<void>;
  cleanup(): Promise<void>;
};

export type PrepareBundledPluginRuntime = (params: {
  repoRoot: string;
}) => PreparedBundledPluginRuntime;

export type WithDistArtifactOwnership = <T>(
  rootDir: string,
  run: () => Promise<T>,
  signal?: AbortSignal,
) => Promise<T>;
