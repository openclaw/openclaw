export type AnchorIdentity = {
  path: string;
  dev: bigint;
  ino: bigint;
  uid: bigint;
  mode: bigint;
};
export type CacheLock = {
  cache: string;
  path: string;
  identity: Omit<AnchorIdentity, "path">;
  owner: string;
};
export declare const ANCHOR_PREFIX: string;
export declare const dependencyCacheRoot: () => string;
export declare function claimCreatedAnchor(path: string, creatorPid: number): AnchorIdentity;
export declare function withDependencyCacheLock<T>(
  cache: string,
  operation: (lock: CacheLock) => T,
): T;
export declare function holdDependencyCache(
  lock: CacheLock,
  entry: string,
  anchor: AnchorIdentity,
): boolean;
export declare function publishDependencyCache(
  lock: CacheLock,
  stage: string,
  entry: string,
  anchor: AnchorIdentity,
): void;
export declare function assertDependencyTarget(target: string, destination: string): void;
export declare function privateDependencyDonor(root: string, destination: string): boolean;
export declare function collectUnusedDependencyCaches(lock: CacheLock, current?: string): string[];
export declare function retireAnchorDependencies(anchor: AnchorIdentity, retire: () => void): void;
