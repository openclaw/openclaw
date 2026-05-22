import fs from "node:fs";

//#region node_modules/@openclaw/fs-safe/dist/root-path.d.ts
type RootPathAliasPolicy = {
  allowFinalSymlinkForUnlink?: boolean;
  allowFinalHardlinkForUnlink?: boolean;
};
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/path-policy.d.ts
type PathAliasPolicy = RootPathAliasPolicy;
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/pinned-open.d.ts
type PinnedOpenSyncFailureReason = "path" | "validation" | "io";
type PinnedOpenSyncAllowedType = "file" | "directory";
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/root-file.d.ts
type BoundaryReadFs = Pick<typeof fs, "closeSync" | "constants" | "fstatSync" | "lstatSync" | "openSync" | "readFileSync" | "realpathSync">;
type RootFileOpenFailureReason = PinnedOpenSyncFailureReason | "validation";
type RootFileOpenResult = {
  ok: true;
  path: string;
  fd: number;
  stat: fs.Stats;
  rootRealPath: string;
} | {
  ok: false;
  reason: RootFileOpenFailureReason;
  error?: unknown;
};
type RootFileOpenFailure = Extract<RootFileOpenResult, {
  ok: false;
}>;
type OpenRootFileSyncParams = {
  absolutePath: string;
  rootPath: string;
  boundaryLabel: string;
  rootRealPath?: string;
  maxBytes?: number;
  rejectHardlinks?: boolean;
  allowedType?: PinnedOpenSyncAllowedType;
  skipLexicalRootCheck?: boolean;
  ioFs?: BoundaryReadFs;
};
type OpenRootFileParams = OpenRootFileSyncParams & {
  aliasPolicy?: PathAliasPolicy;
};
declare function canUseRootFileOpen(ioFs: typeof fs): boolean;
declare function openRootFileSync(params: OpenRootFileSyncParams): RootFileOpenResult;
declare function matchRootFileOpenFailure<T>(failure: RootFileOpenFailure, handlers: {
  path?: (failure: RootFileOpenFailure) => T;
  validation?: (failure: RootFileOpenFailure) => T;
  io?: (failure: RootFileOpenFailure) => T;
  fallback: (failure: RootFileOpenFailure) => T;
}): T;
declare function openRootFile(params: OpenRootFileParams): Promise<RootFileOpenResult>;
//#endregion
export { RootFileOpenResult as a, openRootFile as c, RootFileOpenFailureReason as i, openRootFileSync as l, OpenRootFileSyncParams as n, canUseRootFileOpen as o, RootFileOpenFailure as r, matchRootFileOpenFailure as s, OpenRootFileParams as t };