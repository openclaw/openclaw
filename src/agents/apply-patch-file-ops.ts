import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { openRootFile, type RootFileOpenResult } from "../infra/boundary-file-read.js";
import { FsSafeError, root as fsRoot } from "../infra/fs-safe.js";
import {
  captureAgentToolSourceExecutionGuard,
  runWithAgentToolSourceExecutionScope,
} from "./agent-tool-source-execution-guard.js";
import { writeHostFile } from "./host-file-write.js";
import {
  type MemoryWriteProvenanceObserver,
  withMemoryWriteProvenance,
} from "./memory-write-provenance.js";
import { toRelativeSandboxPath } from "./path-policy.js";
import { isPathBoundaryEscapeError, markHostRootEscape } from "./sandbox-paths.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
import { decodeUtf8File } from "./utf8-file.js";
import { resolveHostWorkspaceRoot } from "./workspace-write-scope.js";

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
    return withPatchMemoryWriteProvenance(options.memoryWriteProvenance, {
      readFile: (filePath) =>
        runWithAgentToolSourceExecutionScope(assertCurrent, async () => {
          const buf = await bridge.readFile({ filePath, cwd: root });
          assertCurrent();
          return decodeUtf8File(buf, filePath);
        }),
      writeFile: (filePath, content) =>
        runWithAgentToolSourceExecutionScope(assertCurrent, async () => {
          assertCurrent();
          await bridge.writeFile({ filePath, cwd: root, data: content, signal: options.signal });
        }),
      createFileExclusive: (filePath, content) =>
        runWithAgentToolSourceExecutionScope(assertCurrent, async () => {
          if (!bridge.createFileExclusive) {
            throw new Error(
              "Sandbox filesystem bridge does not support atomic file creation; refusing to overwrite an existing path.",
            );
          }
          assertCurrent();
          return await bridge.createFileExclusive({
            filePath,
            cwd: root,
            data: content,
            signal: options.signal,
          });
        }),
      remove: (filePath) =>
        runWithAgentToolSourceExecutionScope(assertCurrent, async () => {
          assertCurrent();
          await bridge.remove({ filePath, cwd: root, force: false, signal: options.signal });
        }),
      mkdirp: (dir) =>
        runWithAgentToolSourceExecutionScope(assertCurrent, async () => {
          assertCurrent();
          await bridge.mkdirp({ filePath: dir, cwd: root, signal: options.signal });
        }),
    });
  }

  if (options.workspaceOnly === false) {
    return withPatchMemoryWriteProvenance(options.memoryWriteProvenance, {
      readFile: (filePath) =>
        runWithAgentToolSourceExecutionScope(assertCurrent, async () => {
          const buffer = await fs.readFile(filePath);
          assertCurrent();
          return decodeUtf8File(buffer, filePath);
        }),
      writeFile: async (filePath, content) => {
        await writeHostFile(filePath, content, options.signal);
      },
      createFileExclusive: async (filePath, content) => {
        try {
          await runWithAgentToolSourceExecutionScope(assertCurrent, async () => {
            assertCurrent();
            await fs.writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
          });
          return "created";
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            return "exists";
          }
          throw error;
        }
      },
      remove: (filePath) =>
        runWithAgentToolSourceExecutionScope(assertCurrent, async () => {
          assertCurrent();
          await fs.rm(filePath);
        }),
      mkdirp: async (dir) => {
        await runWithAgentToolSourceExecutionScope(assertCurrent, async () => {
          assertCurrent();
          await fs.mkdir(dir, { recursive: true });
        });
      },
    });
  }

  const containmentRoot = options.root ?? options.cwd;
  const initialRoot = await fsRoot(containmentRoot, { assertBeforeMutation: assertCurrent });
  const roots = new Map([[path.resolve(containmentRoot), initialRoot]]);
  const resolveTarget = async (filePath: string) => {
    const selectedRoot = resolveHostWorkspaceRoot(containmentRoot, filePath);
    const relative = toRelativeSandboxPath(selectedRoot, filePath);
    let root = roots.get(selectedRoot);
    if (!root) {
      root = await fsRoot(selectedRoot, { assertBeforeMutation: assertCurrent });
      roots.set(selectedRoot, root);
    }
    const assertBeforeMutation = () => {
      assertCurrent();
      toRelativeSandboxPath(resolveHostWorkspaceRoot(containmentRoot, filePath), filePath);
    };
    return { root, relative, assertBeforeMutation };
  };
  // Rebase only the admitted root spelling. Root owns parent-alias resolution;
  // absolute paths keep a literal "~" component from becoming home expansion.
  return withPatchMemoryWriteProvenance(options.memoryWriteProvenance, {
    readFile: (filePath) =>
      runWithAgentToolSourceExecutionScope(assertCurrent, async () => {
        const selectedRoot = resolveHostWorkspaceRoot(containmentRoot, filePath);
        const opened = await openRootFile({
          absolutePath: filePath,
          rootPath: selectedRoot,
          boundaryLabel: "workspace root",
          symlinks: "follow-parents-within-root",
        });
        assertBoundaryRead(opened, filePath);
        try {
          assertCurrent();
          return decodeUtf8File(syncFs.readFileSync(opened.fd), filePath);
        } finally {
          syncFs.closeSync(opened.fd);
        }
      }),
    writeFile: async (filePath, content) => {
      await runWithAgentToolSourceExecutionScope(assertCurrent, async () => {
        const { root, relative, assertBeforeMutation } = await resolveTarget(filePath);
        assertBeforeMutation();
        await root
          .write(path.resolve(root.rootReal, relative), content, {
            encoding: "utf8",
            mutationSymlinks: "follow-parents-within-root",
            assertBeforeMutation,
          })
          .catch(rethrowHostMutationError);
      });
    },
    createFileExclusive: async (filePath, content) => {
      try {
        await runWithAgentToolSourceExecutionScope(assertCurrent, async () => {
          const { root, relative, assertBeforeMutation } = await resolveTarget(filePath);
          assertBeforeMutation();
          await root.create(path.resolve(root.rootReal, relative), content, {
            encoding: "utf8",
            mutationSymlinks: "reject",
            assertBeforeMutation,
          });
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
      await runWithAgentToolSourceExecutionScope(assertCurrent, async () => {
        const { root, relative, assertBeforeMutation } = await resolveTarget(filePath);
        assertBeforeMutation();
        // remove requires a relative path; "./" preserves literal tilde names.
        // Omitted mutationSymlinks lets it unlink the final symlink itself.
        await root
          .remove(`./${relative}`, { assertBeforeMutation })
          .catch(rethrowHostMutationError);
      });
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

function withPatchMemoryWriteProvenance(
  observer: MemoryWriteProvenanceObserver | undefined,
  operations: PatchFileOps,
): PatchFileOps {
  const observedOperations = withMemoryWriteProvenance(operations, observer);
  if (!observer) {
    return observedOperations;
  }
  return {
    ...observedOperations,
    createFileExclusive: async (filePath, content) => {
      if (!(await observer.classifies(filePath))) {
        return operations.createFileExclusive(filePath, content);
      }
      try {
        await observer.write({
          absolutePath: filePath,
          contentBefore: "",
          contentAfter: content,
          commit: async () => {
            if ((await operations.createFileExclusive(filePath, content)) === "exists") {
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
