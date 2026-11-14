type Launch = {
  argv: string[] | null;
  options?: {
    stdio?: unknown;
    detached?: boolean;
    env?: Record<string, string | undefined>;
    [key: string]: unknown;
  };
};
type Runtime = {
  root: string;
  rootIdentity: string;
  manifestSha256: string;
  closureSha256: string;
  dependencyRoot: string;
  dependencyIdentity: string;
  dependencySha256: string;
  qualificationStartedAt: string;
  qualifiedAt: string;
};
type Qualified = {
  root: string;
  rootIdentity: string;
  manifestSha256: string;
  inventorySha256: string;
  sourceCommit: string;
};
type Specification = {
  compileCacheBase?: string;
  heartbeatWorkers?: {
    sourceCommit: string;
    inventorySha256: string;
    inventory?: { path: string; sha256: string };
    dependencies?: { sha256: string };
    dependencyReferenceSha256?: string;
  }[];
};
export function captureDirectoryWatchLaunch(
  command: string,
  launch: Launch,
  environment:
    | {
        environmentQualified: boolean;
        inheritedCache: null | {
          base: string;
          directory: string;
          ancestorsPhysical: boolean;
          stateDisjoint: boolean;
        };
      }
    | undefined,
): (Runtime & { executableIdentity: string; environment: object }) | undefined;
export function captureRetainedDirectoryWatchRuntime(
  launch: Launch,
  qualified: Qualified | undefined,
  spec: Specification,
):
  | (Runtime & {
      directory: string;
      directoryIdentity: string;
      sourceRoot: string;
      sourceRootIdentity: string;
      sourceCommit: string;
      inventorySha256: string;
      entry: string;
      entrySha256: string;
      capturedAt: string;
    })
  | undefined;
export function directoryWatchCoverage(
  created: Record<string, unknown>,
  rows: Record<string, unknown>[],
  spec: Specification,
  isPackageRoot: (root: string) => boolean,
): { role: string; reason: string; sha256: string } | undefined;
