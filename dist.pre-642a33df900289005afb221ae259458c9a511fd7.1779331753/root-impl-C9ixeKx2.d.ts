import { Stats } from "node:fs";
import { FileHandle } from "node:fs/promises";

//#region node_modules/@openclaw/fs-safe/dist/types.d.ts
type PathStat = {
  dev: number;
  gid: number;
  ino: number;
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
  mode: number;
  mtimeMs: number;
  nlink: number;
  size: number;
  uid: number;
};
type DirEntry = PathStat & {
  name: string;
};
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/root-impl.d.ts
type OpenResult = {
  handle: FileHandle;
  realPath: string;
  stat: Stats;
  [Symbol.asyncDispose](): Promise<void>;
};
type ReadResult = {
  buffer: Buffer;
  realPath: string;
  stat: Stats;
};
type SymlinkPolicy = "reject" | "follow-within-root";
type HardlinkPolicy = "reject" | "allow";
type WritableOpenMode = "replace" | "append" | "update";
type RootDefaults = {
  hardlinks?: HardlinkPolicy;
  maxBytes?: number;
  mkdir?: boolean;
  mode?: number;
  nonBlockingRead?: boolean;
  symlinks?: SymlinkPolicy;
};
type RootReadOptions = Pick<RootDefaults, "hardlinks" | "maxBytes" | "nonBlockingRead" | "symlinks">;
type RootOpenOptions = Omit<RootReadOptions, "maxBytes">;
type RootWriteOptions = Pick<RootDefaults, "mkdir" | "mode"> & {
  encoding?: BufferEncoding;
  overwrite?: boolean;
};
type RootOpenWritableOptions = Pick<RootDefaults, "mkdir" | "mode"> & {
  writeMode?: WritableOpenMode;
};
type RootCopyOptions = Pick<RootDefaults, "maxBytes" | "mkdir" | "mode"> & {
  sourceHardlinks?: HardlinkPolicy;
};
type RootWriteJsonOptions = RootWriteOptions & {
  replacer?: Parameters<typeof JSON.stringify>[1];
  space?: Parameters<typeof JSON.stringify>[2];
  trailingNewline?: boolean;
};
type RootCreateOptions = Omit<RootWriteOptions, "overwrite">;
type RootCreateJsonOptions = Omit<RootWriteJsonOptions, "overwrite">;
type RootAppendOptions = RootWriteOptions & {
  prependNewlineIfNeeded?: boolean;
};
interface Root {
  readonly rootDir: string;
  readonly rootReal: string;
  readonly rootWithSep: string;
  readonly defaults: RootDefaults;
  resolve(relativePath: string): Promise<string>;
  open(relativePath: string, options?: RootOpenOptions): Promise<OpenResult>;
  read(relativePath: string, options?: RootReadOptions): Promise<ReadResult>;
  readBytes(relativePath: string, options?: RootReadOptions): Promise<Buffer>;
  readText(relativePath: string, options?: RootReadOptions & {
    encoding?: BufferEncoding;
  }): Promise<string>;
  readJson<T = unknown>(relativePath: string, options?: RootReadOptions & {
    encoding?: BufferEncoding;
  }): Promise<T>;
  readAbsolute(filePath: string, options?: RootReadOptions): Promise<ReadResult>;
  reader(options?: RootReadOptions): (filePath: string) => Promise<Buffer>;
  openWritable(relativePath: string, options?: RootOpenWritableOptions): Promise<WritableOpenResult>;
  append(relativePath: string, data: string | Buffer, options?: RootAppendOptions): Promise<void>;
  remove(relativePath: string): Promise<void>;
  mkdir(relativePath: string): Promise<void>;
  ensureRoot(): Promise<void>;
  write(relativePath: string, data: string | Buffer, options?: RootWriteOptions): Promise<void>;
  create(relativePath: string, data: string | Buffer, options?: RootCreateOptions): Promise<void>;
  writeJson(relativePath: string, data: unknown, options?: RootWriteJsonOptions): Promise<void>;
  createJson(relativePath: string, data: unknown, options?: RootCreateJsonOptions): Promise<void>;
  copyIn(relativePath: string, sourcePath: string, options?: RootCopyOptions): Promise<void>;
  exists(relativePath: string): Promise<boolean>;
  stat(relativePath: string): Promise<PathStat>;
  list(relativePath: string, options?: {
    withFileTypes?: false;
  }): Promise<string[]>;
  list(relativePath: string, options: {
    withFileTypes: true;
  }): Promise<DirEntry[]>;
  move(fromRelative: string, toRelative: string, options?: {
    overwrite?: boolean;
  }): Promise<void>;
}
declare function root(rootDir: string, defaults?: RootDefaults): Promise<Root>;
declare function readLocalFileSafely(params: {
  filePath: string;
  maxBytes?: number;
}): Promise<ReadResult>;
declare function openLocalFileSafely(params: {
  filePath: string;
}): Promise<OpenResult>;
type WritableOpenResult = {
  handle: FileHandle;
  createdForWrite: boolean;
  realPath: string;
  stat: Stats;
  [Symbol.asyncDispose](): Promise<void>;
};
declare function resolveOpenedFileRealPathForHandle(handle: FileHandle, ioPath: string): Promise<string>;
//#endregion
export { RootReadOptions as a, readLocalFileSafely as c, Root as i, resolveOpenedFileRealPathForHandle as l, OpenResult as n, SymlinkPolicy as o, ReadResult as r, openLocalFileSafely as s, HardlinkPolicy as t, root as u };