import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { openRootFile, type RootFileOpenResult } from "../infra/boundary-file-read.js";
import { FsSafeError, root as fsRoot } from "../infra/fs-safe.js";
import { captureAgentToolSourceExecutionGuard } from "./agent-tool-source-execution-guard.js";
import { writeHostFile } from "./host-file-write.js";
import {
  type MemoryWriteProvenanceObserver,
  withMemoryWriteProvenance,
} from "./memory-write-provenance.js";
import { toRelativeSandboxPath } from "./path-policy.js";
import { isPathBoundaryEscapeError, markHostRootEscape } from "./sandbox-paths.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
import { decodeUtf8File } from "./utf8-file.js";

export type SandboxApplyPatchConfig = {
  root: string;
  bridge: SandboxFsBridge;
  /** Prepared workspace admission mappings; legacy SDK bridges may omit them. */
  workspaceMounts?: readonly { containerRoot: string; hostRoot: string }[];
};

export type ApplyPatchFileOptions = {
  signal?: AbortSignal;
  cwd: string;
  /** Containment boundary when relative paths resolve from a nested cwd. */
  root?: string;
  sandbox?: SandboxApplyPatchConfig;
  /** Restrict patch paths to the workspace root (cwd). Default: true. Set false to opt out. */
  workspaceOnly?: boolean;
  memoryWriteProvenance?: MemoryWriteProvenanceObserver;
};

type PatchCreateOutcome = "created" | "exists";

export type PatchFileOps = {
  readFile: (filePath: string) => Promise<string>;
  writeFile: (filePath: string, content: string) => Promise<void>;
  createFileExclusive: (filePath: string, content: string) => Promise<PatchCreateOutcome>;
  remove: (filePath: string) => Promise<void>;
  /** Omit when exclusive creation owns parent directories. */
  mkdirp?: (dir: string) => Promise<void>;
};

export async function createPatchTarget(params: {
  target: { resolved: string; display: string };
  contents: string;
  ops: PatchFileOps;
  hint: string;
}) {
  const outcome = await params.ops.createFileExclusive(params.target.resolved, params.contents);
  if (outcome === "exists") {
    throw new Error(
      `Cannot create ${params.target.display}: the file already exists. ${params.hint}`,
    );
  }
}

export async function resolvePatchFileOps(options: ApplyPatchFileOptions): Promise<PatchFileOps> {
  const assertCurrent = captureAgentToolSourceExecutionGuard(options.signal);
  if (options.sandbox) {
    const { root, bridge } = options.sandbox;
    return withPatchMemoryWriteProvenance({
      observer: options.memoryWriteProvenance,
      operations: {
        readFile: async (filePath) => {
          const buf = await bridge.readFile({ filePath, cwd: root });
          return decodeUtf8File(buf, filePath);
        },
        writeFile: (filePath, content) => {
          assertCurrent();
          return bridge.writeFile({ filePath, cwd: root, data: content, signal: options.signal });
        },
        createFileExclusive: (filePath, content) => {
          if (!bridge.createFileExclusive) {
            throw new Error(
              "Sandbox filesystem bridge does not support atomic file creation; refusing to overwrite an existing path.",
            );
          }
          assertCurrent();
          return bridge.createFileExclusive({
            filePath,
            cwd: root,
            data: content,
            signal: options.signal,
          });
        },
        remove: (filePath) => {
          assertCurrent();
          return bridge.remove({ filePath, cwd: root, force: false, signal: options.signal });
        },
        mkdirp: (dir) => {
          assertCurrent();
          return bridge.mkdirp({ filePath: dir, cwd: root, signal: options.signal });
        },
      },
    });
  }

  if (options.workspaceOnly === false) {
    return withPatchMemoryWriteProvenance({
      observer: options.memoryWriteProvenance,
      operations: {
        readFile: async (filePath) => decodeUtf8File(await fs.readFile(filePath), filePath),
        writeFile: async (filePath, content) => {
          await writeHostFile(filePath, content, options.signal);
        },
        createFileExclusive: async (filePath, content) => {
          try {
            assertCurrent();
            await fs.writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
            return "created";
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") {
              return "exists";
            }
            throw error;
          }
        },
        remove: (filePath) => {
          assertCurrent();
          return fs.rm(filePath);
        },
        mkdirp: async (dir) => {
          assertCurrent();
          await fs.mkdir(dir, { recursive: true });
        },
      },
    });
  }

  const containmentRoot = options.root ?? options.cwd;
  const root = await fsRoot(containmentRoot, { assertBeforeMutation: assertCurrent });
  // Rebase only the admitted root spelling. Root owns parent-alias resolution;
  // absolute paths keep a literal "~" component from becoming home expansion.
  const toRootPath = (filePath: string) =>
    path.resolve(root.rootReal, toRelativeSandboxPath(root.rootDir, filePath));
  return withPatchMemoryWriteProvenance({
    observer: options.memoryWriteProvenance,
    operations: {
      readFile: async (filePath) => {
        const opened = await openRootFile({
          absolutePath: filePath,
          rootPath: containmentRoot,
          boundaryLabel: "workspace root",
          symlinks: "follow-parents-within-root",
        });
        assertBoundaryRead(opened, filePath);
        try {
          return decodeUtf8File(syncFs.readFileSync(opened.fd), filePath);
        } finally {
          syncFs.closeSync(opened.fd);
        }
      },
      writeFile: async (filePath, content) => {
        assertCurrent();
        await root
          .write(toRootPath(filePath), content, {
            encoding: "utf8",
            mutationSymlinks: "follow-parents-within-root",
          })
          .catch(rethrowHostMutationError);
      },
      createFileExclusive: async (filePath, content) => {
        try {
          assertCurrent();
          await root.create(toRootPath(filePath), content, {
            encoding: "utf8",
            mutationSymlinks: "reject",
          });
          return "created";
        } catch (error) {
          if (error instanceof FsSafeError && error.code === "already-exists") {
            return "exists";
          }
          return rethrowHostMutationError(error);
        }
      },
      remove: async (filePath) => {
        assertCurrent();
        // remove requires a relative path; "./" preserves literal tilde names.
        // Omitted mutationSymlinks lets it unlink the final symlink itself.
        await root
          .remove(`./${toRelativeSandboxPath(root.rootDir, filePath)}`)
          .catch(rethrowHostMutationError);
      },
    },
  });
}

function rethrowHostMutationError(error: unknown): never {
  // Root also uses path-alias for non-boundary failures; only escapes get a remedy.
  if (
    error instanceof FsSafeError &&
    (error.code === "outside-workspace" ||
      (error.code === "path-alias" &&
        error.cause instanceof Error &&
        /^(?:Path escapes|Path resolves outside|Symlink escapes) root \(/.test(
          error.cause.message,
        )))
  ) {
    markHostRootEscape(error);
  }
  throw error;
}

class PatchCreateExistsSignal extends Error {}

function withPatchMemoryWriteProvenance(params: {
  operations: PatchFileOps;
  observer: MemoryWriteProvenanceObserver | undefined;
}): PatchFileOps {
  const observer = params.observer;
  const operations = withMemoryWriteProvenance(params.operations, observer);
  if (!observer) {
    return operations;
  }
  return {
    ...operations,
    createFileExclusive: async (filePath, content) => {
      if (!(await observer.classifies(filePath))) {
        return params.operations.createFileExclusive(filePath, content);
      }
      try {
        await observer.write({
          absolutePath: filePath,
          contentBefore: "",
          contentAfter: content,
          commit: async () => {
            if ((await params.operations.createFileExclusive(filePath, content)) === "exists") {
              throw new PatchCreateExistsSignal();
            }
          },
        });
        return "created";
      } catch (error) {
        if (error instanceof PatchCreateExistsSignal) {
          return "exists";
        }
        throw error;
      }
    },
  };
}

function assertBoundaryRead(
  opened: RootFileOpenResult,
  targetPath: string,
): asserts opened is Extract<RootFileOpenResult, { ok: true }> {
  if (opened.ok) {
    return;
  }
  const reason = opened.reason === "validation" ? "unsafe path" : "path not found";
  const error = new Error(`Failed boundary read for ${targetPath} (${reason})`) as Error & {
    code?: string;
  };
  const sourceCode =
    opened.error && typeof opened.error === "object" && "code" in opened.error
      ? opened.error.code
      : undefined;
  if (sourceCode === "ENOENT" || sourceCode === "ENOTDIR") {
    // Preserve the producer's classification so provenance observers do not parse messages.
    error.code = sourceCode;
  }
  if (
    opened.reason === "validation" &&
    ((opened.error instanceof FsSafeError && opened.error.code === "outside-workspace") ||
      isPathBoundaryEscapeError(opened.error, "workspace root"))
  ) {
    markHostRootEscape(error);
  }
  throw error;
}
