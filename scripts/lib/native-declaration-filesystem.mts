import fs from "node:fs";
import path from "node:path";
import type { FileSystem } from "typescript/unstable/fs";
import { createDeclarationInputBoundary } from "./local-check-runtime.mts";

export type DeclarationLookup =
  | { kind: "readFile" | "fileExists" | "directoryExists"; path: string; result: boolean }
  | {
      kind: "getAccessibleEntries";
      path: string;
      result: { files: string[]; directories: string[] };
    }
  | { kind: "realpath"; path: string; result: string };

/** Record compiler reads and apply the caller's checkout policy when supplied. */
export function createDeclarationFileSystem(
  cwd: string,
  admit: ((file: string) => string) | undefined,
  virtualFiles: ReadonlyMap<string, string>,
  readText: (file: string) => string = (file) => fs.readFileSync(file, "utf8"),
) {
  const boundary = admit ? createDeclarationInputBoundary(cwd) : undefined;
  const resolve = (file: string) => boundary?.resolve(file) ?? path.resolve(cwd, file);
  const inputs = new Set<string>();
  const lookups = new Map<string, DeclarationLookup>();
  let failure: Error | undefined;
  const reject = (error: unknown) => {
    failure ??= error instanceof Error ? error : new Error(String(error));
  };
  const assertValid = () => {
    if (failure) {
      throw failure;
    }
  };
  const observe = (lookup: DeclarationLookup) => {
    if (!boundary) {
      return;
    }
    const absolute = resolve(lookup.path);
    const relative = path.relative(boundary.root, absolute);
    // Virtual configs derive from sealed options; outside candidates are always denied.
    if (
      virtualFiles.has(absolute) ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      return;
    }
    const file = relative.split(path.sep).join("/") || ".";
    const recorded: DeclarationLookup =
      lookup.kind === "realpath"
        ? {
            ...lookup,
            path: file,
            result: path.relative(boundary.root, lookup.result).split(path.sep).join("/") || ".",
          }
        : { ...lookup, path: file };
    const key = `${recorded.kind}\0${recorded.path}`;
    const previous = lookups.get(key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(recorded)) {
      reject(new Error(`Native compiler lookup changed during compilation: ${recorded.path}`));
    }
    lookups.set(key, recorded);
  };
  const local = (file: string) => {
    const absolute = resolve(file);
    if (!boundary || !admit) {
      return absolute;
    }
    const relative = path.relative(boundary.root, absolute);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return undefined;
    }
    // A local alias must not expose an external installation. Outside lexical
    // candidates are absent even if a symlink would lead back into the checkout.
    try {
      return admit(boundary.assert(absolute));
    } catch (error) {
      // A thrown RPC callback can strand the native request. Deny the lookup
      // and report its original boundary error after that request settles.
      reject(error);
      return undefined;
    }
  };
  const missing = (error: unknown) =>
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR");
  const stat = (file: string) => {
    try {
      return fs.statSync(file, { throwIfNoEntry: false });
    } catch (error) {
      if (missing(error)) {
        return undefined;
      }
      reject(error);
      return undefined;
    }
  };
  const physical = {
    readFile(file) {
      const accepted = local(file);
      if (accepted === undefined) {
        return null;
      }
      const virtual = virtualFiles.get(accepted);
      if (virtual !== undefined) {
        return virtual;
      }
      try {
        const text = readText(accepted);
        inputs.add(accepted);
        return text;
      } catch (error) {
        if (missing(error)) {
          return null;
        }
        reject(error);
        return null;
      }
    },
    fileExists(file) {
      const accepted = local(file);
      return (
        accepted !== undefined && (virtualFiles.has(accepted) || stat(accepted)?.isFile() === true)
      );
    },
    directoryExists(directory) {
      const accepted = local(directory);
      return accepted !== undefined && stat(accepted)?.isDirectory() === true;
    },
    getAccessibleEntries(directory) {
      const accepted = local(directory);
      const entries = { files: [] as string[], directories: [] as string[] };
      if (accepted === undefined) {
        return entries;
      }
      try {
        for (const entry of fs.readdirSync(accepted, { withFileTypes: true })) {
          const file = entry.isSymbolicLink() ? local(path.join(accepted, entry.name)) : undefined;
          if (entry.isSymbolicLink() && file === undefined) {
            continue;
          }
          const isDirectory = file === undefined ? entry.isDirectory() : stat(file)?.isDirectory();
          (isDirectory ? entries.directories : entries.files).push(entry.name);
        }
        return entries;
      } catch (error) {
        if (missing(error)) {
          return entries;
        }
        reject(error);
        return entries;
      }
    },
    realpath(file) {
      const accepted = local(file);
      // Returning undefined delegates to the host filesystem, including outside
      // paths. Missing paths retain their spelling instead of escaping the view.
      if (accepted === undefined || virtualFiles.has(accepted)) {
        return resolve(file);
      }
      try {
        const real = fs.realpathSync.native(accepted);
        return boundary?.assert(real) ?? real;
      } catch (error) {
        if (!missing(error)) {
          reject(error);
        }
        return accepted;
      }
    },
    writeFile(this: void) {
      reject(new Error("Native declarations must be emitted in memory"));
    },
  } satisfies FileSystem;
  const filesystem = {
    readFile(file: string) {
      const result = physical.readFile(file);
      observe({ kind: "readFile", path: file, result: result !== null });
      return result;
    },
    fileExists(file: string) {
      const result = physical.fileExists(file);
      observe({ kind: "fileExists", path: file, result });
      return result;
    },
    directoryExists(directory: string) {
      const result = physical.directoryExists(directory);
      observe({ kind: "directoryExists", path: directory, result });
      return result;
    },
    getAccessibleEntries(directory: string) {
      const result = physical.getAccessibleEntries(directory);
      observe({ kind: "getAccessibleEntries", path: directory, result });
      return result;
    },
    realpath(file: string) {
      const result = physical.realpath(file);
      observe({ kind: "realpath", path: file, result });
      return result;
    },
    writeFile: physical.writeFile,
  } satisfies FileSystem;
  return {
    filesystem,
    inputs,
    getLookups() {
      assertValid();
      return [...lookups]
        .toSorted(([left], [right]) => (left < right ? -1 : 1))
        .map(([, lookup]) => lookup);
    },
    assertValid,
  };
}

/** Replay the same bounded operations, including negative resolution candidates. */
export function replayDeclarationLookups(
  cwd: string,
  admit: (file: string) => string,
  lookups: readonly DeclarationLookup[],
  readText: (file: string) => string,
) {
  const view = createDeclarationFileSystem(cwd, admit, new Map(), readText);
  for (const lookup of lookups) {
    view.filesystem[lookup.kind](lookup.path);
  }
  return view.getLookups();
}
