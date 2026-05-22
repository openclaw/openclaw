import { o as SymlinkPolicy, r as ReadResult, t as HardlinkPolicy } from "./root-impl-C9ixeKx2.js";

//#region node_modules/@openclaw/fs-safe/dist/local-roots.d.ts
type LocalRootsPathResult = {
  path: string;
  root: string;
};
type LocalRootsReadResult = ReadResult & {
  root: string;
};
type LocalRootsInputOptions = {
  filePath: string;
  roots: readonly string[];
  label?: string;
};
type ResolveLocalPathFromRootsSyncOptions = LocalRootsInputOptions & {
  allowMissing?: boolean;
  requireFile?: boolean;
};
type ReadLocalFileFromRootsOptions = LocalRootsInputOptions & {
  hardlinks?: HardlinkPolicy;
  maxBytes?: number;
  nonBlockingRead?: boolean;
  symlinks?: SymlinkPolicy;
};
declare function resolveLocalPathFromRootsSync(options: ResolveLocalPathFromRootsSyncOptions): LocalRootsPathResult | null;
declare function readLocalFileFromRoots(options: ReadLocalFileFromRootsOptions): Promise<LocalRootsReadResult | null>;
//#endregion
export { resolveLocalPathFromRootsSync as n, readLocalFileFromRoots as t };