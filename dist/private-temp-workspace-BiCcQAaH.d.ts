import { n as FileStoreSync, t as FileStore } from "./file-store-P6Ewg_WQ.js";

//#region node_modules/@openclaw/fs-safe/dist/private-temp-workspace.d.ts
type TempWorkspaceOptions = {
  rootDir: string;
  prefix: string;
  dirMode?: number;
  mode?: number;
};
type TempWorkspace = {
  dir: string;
  store: FileStore;
  path(fileName: string): string;
  write(fileName: string, data: string | Uint8Array): Promise<string>;
  writeText(fileName: string, data: string): Promise<string>;
  writeJson(fileName: string, data: unknown, options?: {
    trailingNewline?: boolean;
  }): Promise<string>;
  copyIn(fileName: string, sourcePath: string): Promise<string>;
  read(fileName: string): Promise<Buffer>;
  cleanup(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
};
type TempWorkspaceSync = {
  dir: string;
  store: FileStoreSync;
  path(fileName: string): string;
  write(fileName: string, data: string | Uint8Array): string;
  writeText(fileName: string, data: string): string;
  writeJson(fileName: string, data: unknown, options?: {
    trailingNewline?: boolean;
  }): string;
  read(fileName: string): Buffer;
  cleanup(): void;
  [Symbol.dispose](): void;
};
declare function tempWorkspace(options: TempWorkspaceOptions): Promise<TempWorkspace>;
declare function withTempWorkspace<T>(options: TempWorkspaceOptions, run: (workspace: TempWorkspace) => Promise<T>): Promise<T>;
declare function tempWorkspaceSync(options: TempWorkspaceOptions): TempWorkspaceSync;
declare function withTempWorkspaceSync<T>(options: TempWorkspaceOptions, run: (workspace: TempWorkspaceSync) => T): T;
//#endregion
export { tempWorkspaceSync as a, tempWorkspace as i, TempWorkspaceOptions as n, withTempWorkspace as o, TempWorkspaceSync as r, withTempWorkspaceSync as s, TempWorkspace as t };