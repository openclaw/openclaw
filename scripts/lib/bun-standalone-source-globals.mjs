/** Type-only runtime bridge for original TypeScript compiled into the standalone image. */
export function createStandaloneSourceGlobals() {
  return `import type { Dirent, PathLike, Stats } from "node:fs";
import type { createRequire } from "node:module";

type StandaloneImageScope = {
  rootDir: string;
  relativePath: string;
  rootRealPath?: string;
};
type StandaloneImageEntry = {
  ok: true;
  path: string;
  rootRealPath: string;
  exists: true;
};
type StandaloneImageFile = {
  ok: true;
  path: string;
  rootRealPath: string;
  contents: Buffer;
  hash: string;
  signature: { size: number; mtimeMs: number; ctimeMs: number };
};
type StandaloneFileScope = {
  rootPath: string;
  rootRealPath?: string;
} & ({ filePath: string; absolutePath?: string } | { absolutePath: string; filePath?: string });
type StandaloneOperationArtifact = {
  rootDir: string;
  hasSource(source: string): boolean;
  resolve(source: string, rejectHardlinks?: boolean): string;
  prepareModule(filename: string): string[];
  linkHost(hostRoot: string): void;
  dispose(): void;
  disposeAsync(): Promise<void>;
};
type StandaloneNativeRequire = {
  (parent: string, specifier: string): unknown;
  resolve(parent: string, ...args: Parameters<NodeJS.RequireResolve>): string;
};

declare global {
  var __openclawStandaloneRootUrl: string;
  var __openclawStandaloneUnrenderedModuleUrl: (marker: string) => string;
  var __openclawStandaloneExternalModulePath: (pathname: string) => string | undefined;
  var __openclawStandaloneExternalModuleResolution: (pathname: string) => { path: string; namespace: string };
  var __openclawStandaloneEmbeddedPath: (pathname: string) => string | undefined;
  var __openclawStandaloneOriginalPath: (filename: string) => string;
  var __openclawStandaloneResolve: (parent: string, specifier: string, from?: string) => string;
  var __openclawStandaloneImport: <T>(
    parent: string,
    specifier: string,
    options: ImportCallOptions | undefined,
    original: () => Promise<T>,
  ) => Promise<T>;
  var __openclawStandaloneCreateRequire: (
    create: typeof createRequire,
    ...args: Parameters<typeof createRequire>
  ) => ReturnType<typeof createRequire>;
  var __openclawStandaloneNativePath: (relative: string) => string;
  var __openclawStandaloneNativeResolve: (parent: string, specifier: unknown) => string | undefined;
  var __openclawStandaloneNativeResolvePaths: (parent: string, specifier: unknown) => string[] | undefined;
  var __openclawStandaloneNativeRequire: StandaloneNativeRequire;

  var __openclawStandaloneImageStat: (filename: PathLike, lstat?: boolean) => Stats | undefined;
  var __openclawStandaloneImageLstat: (filename: PathLike) => Stats | undefined;
  var __openclawStandaloneImageExists: (filename: PathLike) => boolean | undefined;
  var __openclawStandaloneImageRealpath: (filename: PathLike) => string | undefined;
  var __openclawStandaloneImageDirectory: (directory: string, read: () => Dirent[]) => Dirent[];
  var __openclawStandaloneImageCheck: <T extends StandaloneImageScope>(params: T) => StandaloneImageEntry | undefined;
  var __openclawStandaloneImageRead: <T extends StandaloneImageScope>(params: T) => StandaloneImageFile | undefined;
  var __openclawStandaloneModuleOpen: <T extends StandaloneFileScope>(params: T) => StandaloneImageEntry | undefined;
  var __openclawStandaloneHookEntry: <T extends { rootPath: string; absolutePath: string; source: string }>(params: T) => { ok: true; path: string } | undefined;
  var __openclawStandaloneSqliteWorkerModule: (sourceUrl: URL) => { modulePath: string; moduleUrl: string } | undefined;
  var __openclawStandaloneDoctorHash: (filename: string) => string | undefined;

  var __openclawStandaloneLoadPluginModule: (target: string) => { moduleExport: unknown } | undefined;
  var __openclawStandaloneCaptureOperationArtifact: (
    capture: (rootDir: string, selected?: string | readonly string[]) => StandaloneOperationArtifact,
    rootDir: string,
    selected?: string | readonly string[],
  ) => StandaloneOperationArtifact;
  var __openclawStandaloneFingerprintArtifact: <T extends { origin: string; rootDir: string; source?: string; sourcePreferred?: boolean }>(record: T) => string | undefined;
}
`;
}
