import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { SourceFile } from "typescript/unstable/ast";
import {
  createVirtualFileSystem,
  type FileSystem,
  type FileSystemEntries,
} from "typescript/unstable/fs";
import { API, type Diagnostic, type Project, type Snapshot } from "typescript/unstable/sync";

export type NativeTypeScriptSource = { fileName: string; text: string };
export type NativeTypeScriptParser = ReturnType<typeof createNativeTypeScriptParser>;
export type NativeTypeScriptProject = ReturnType<typeof createNativeTypeScriptProject>;

type ProjectOptions = {
  cwd: string;
  configFileName: string;
  files?: Readonly<Record<string, string>>;
  fs?: FileSystem;
};

/** Select the same installed compiler as the native API, including in relocated tooling. */
export function resolveInstalledNativeTypeScriptCompiler() {
  const require = createRequire(import.meta.url);
  const packageJson = require.resolve("typescript/package.json");
  const getExePath: { default: () => string } = require(
    path.join(path.dirname(packageJson), "lib/getExePath.js"),
  );
  return { executable: getExePath.default(), packageJson };
}

function compilerFileName(cwd: string, file: string) {
  return path.resolve(cwd, file).split(path.sep).join("/");
}

function directoryEntries(directory: string): FileSystemEntries {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return { files: [], directories: [] };
    }
    throw error;
  }
  const files: string[] = [];
  const directories: string[] = [];
  for (const entry of entries) {
    const isDirectory = entry.isSymbolicLink()
      ? fs.statSync(path.join(directory, entry.name), { throwIfNoEntry: false })?.isDirectory()
      : entry.isDirectory();
    (isDirectory ? directories : files).push(entry.name);
  }
  return { files, directories };
}

function overlayFileSystem(
  cwd: string,
  files: Readonly<Record<string, string>>,
  base: FileSystem = {},
): FileSystem {
  const contents = Object.fromEntries(
    Object.entries(files).map(([file, text]) => [compilerFileName(cwd, file), text]),
  );
  const virtual = createVirtualFileSystem(contents);
  const hasFile = (file: string) => Object.hasOwn(contents, compilerFileName(cwd, file));
  return {
    readFile: (file) =>
      hasFile(file) ? contents[compilerFileName(cwd, file)] : base.readFile?.(file),
    fileExists: (file) => (hasFile(file) ? true : base.fileExists?.(file)),
    directoryExists: (directory) =>
      virtual.directoryExists?.(directory) || base.directoryExists?.(directory),
    realpath: (file) => (hasFile(file) ? compilerFileName(cwd, file) : base.realpath?.(file)),
    getAccessibleEntries(directory) {
      const added = virtual.getAccessibleEntries?.(directory);
      if (!added) {
        return base.getAccessibleEntries?.(directory);
      }
      const existing = base.getAccessibleEntries?.(directory) ?? directoryEntries(directory);
      return {
        files: [...new Set([...existing.files, ...added.files])],
        directories: [...new Set([...existing.directories, ...added.directories])],
      };
    },
  };
}

/** Own one native compiler process and its immutable semantic snapshot. */
export function createNativeTypeScriptProject(options: ProjectOptions) {
  const cwd = path.resolve(options.cwd);
  const configFileName = compilerFileName(cwd, options.configFileName);
  const api = new API({
    cwd,
    fs: options.files ? overlayFileSystem(cwd, options.files, options.fs) : options.fs,
  });
  let snapshot: Snapshot;
  let project: Project;
  try {
    snapshot = api.updateSnapshot({ openProjects: [configFileName] });
    const opened = snapshot.getProject(configFileName);
    if (!opened) {
      throw new Error(`Native TypeScript did not open ${configFileName}`);
    }
    project = opened;
  } catch (error) {
    api.close();
    throw error;
  }
  let closed = false;
  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    api.close();
  };
  return { api, snapshot, project, close, [Symbol.dispose]: close };
}

/** Batch syntax scans share one explicit process; source trees remain local after disposal. */
export function createNativeTypeScriptParser({
  cwd = process.cwd(),
  tsserverPath,
}: { cwd?: string; tsserverPath?: string } = {}) {
  const root = path.resolve(cwd);
  const configFileName = compilerFileName(root, ".openclaw-native-parser.tsconfig.json");
  let files: Record<string, string> = {};
  let virtual = createVirtualFileSystem(files);
  let api: API | undefined;
  let snapshot: Snapshot | undefined;
  let project: Project | undefined;
  let sourceNames: string[] = [];
  let closed = false;
  const assertOpen = () => {
    if (closed) {
      throw new Error("Native TypeScript parser is closed");
    }
  };
  const parseSourceFiles = (sources: readonly NativeTypeScriptSource[]): readonly SourceFile[] => {
    assertOpen();
    if (sources.length === 0) {
      snapshot?.dispose();
      project = undefined;
      return [];
    }
    const previous = snapshot;
    const names = sources.map((source) => compilerFileName(root, source.fileName));
    if (new Set(names).size !== names.length) {
      throw new Error("Native TypeScript parser received duplicate source paths");
    }
    if (names.includes(configFileName)) {
      throw new Error(`Native TypeScript parser source conflicts with ${configFileName}`);
    }
    files = Object.fromEntries(
      sources.map((source) => [compilerFileName(root, source.fileName), source.text]),
    );
    files[configFileName] = JSON.stringify({
      compilerOptions: {
        allowJs: true,
        experimentalDecorators: true,
        jsx: "preserve",
        noLib: true,
        noResolve: true,
        target: "esnext",
        types: [],
      },
      files: names,
    });
    virtual = createVirtualFileSystem(files);
    api ??= new API({
      cwd: root,
      tsserverPath,
      fs: {
        readFile: (file) => virtual.readFile?.(file) ?? null,
        fileExists: (file) => virtual.fileExists?.(file) ?? false,
        directoryExists: (directory) => virtual.directoryExists?.(directory) ?? false,
        getAccessibleEntries: (directory) =>
          virtual.getAccessibleEntries?.(directory) ?? { files: [], directories: [] },
        realpath: (file) => file,
      },
    });
    const previousNames = new Set(sourceNames);
    const currentNames = new Set(names);
    snapshot = api.updateSnapshot({
      ...(previous ? {} : { openProjects: [configFileName] }),
      // A config-file change reloads its root list; invalidateAll retains the old roots.
      fileChanges: {
        changed: [configFileName, ...names.filter((name) => previousNames.has(name))],
        created: names.filter((name) => !previousNames.has(name)),
        deleted: sourceNames.filter((name) => !currentNames.has(name)),
      },
    });
    sourceNames = names;
    previous?.dispose();
    project = snapshot.getProject(configFileName);
    if (!project) {
      throw new Error("Native TypeScript did not open the syntax scan project");
    }
    const program = project.program;
    return names.map((fileName) => {
      const sourceFile = program.getSourceFile(fileName);
      if (!sourceFile) {
        throw new Error(`Native TypeScript did not parse ${fileName}`);
      }
      return sourceFile;
    });
  };
  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    api?.close();
    api = undefined;
    project = undefined;
    snapshot = undefined;
    files = {};
    virtual = createVirtualFileSystem(files);
    sourceNames = [];
  };
  return {
    parseSourceFiles,
    parseSourceFile(fileName: string, text: string): SourceFile {
      const sourceFile = parseSourceFiles([{ fileName, text }])[0];
      if (!sourceFile) {
        throw new Error(`Native TypeScript did not parse ${fileName}`);
      }
      return sourceFile;
    },
    getSyntacticDiagnostics(fileName?: string): readonly Diagnostic[] {
      assertOpen();
      return (
        project?.program.getSyntacticDiagnostics(
          fileName === undefined ? undefined : compilerFileName(root, fileName),
        ) ?? []
      );
    },
    close,
    [Symbol.dispose]: close,
  };
}
