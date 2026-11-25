import callbackFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { openRootFile, type RootFileOpenResult } from "../infra/boundary-file-read.js";
import { FsSafeError, root as fsRoot } from "../infra/fs-safe.js";
import { decodeUtf8Input } from "../infra/utf8-input.js";
import {
  prepareHostFileMutation,
  writeHostFile,
  type HostFileMutationPreparer,
} from "./host-file-write.js";
import {
  type MemoryWriteProvenanceObserver,
  withMemoryWriteProvenance,
} from "./memory-write-provenance.js";
import { toRelativeSandboxPath } from "./path-policy.js";
import { isPathBoundaryEscapeError, markHostRootEscape } from "./sandbox-paths.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
import { resolveHostWorkspaceRoot, resolveHostRootAsync } from "./workspace-write-scope.js";

const readFileDescriptor = promisify(callbackFs.readFile);
const closeFileDescriptor = promisify(callbackFs.close);

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
  /** Restrict patch paths to the workspace root (cwd). Host default: false; sandbox default: true. */
  workspaceOnly?: boolean;
  strictWorkspaceRoot?: boolean;
  memoryWriteProvenance?: MemoryWriteProvenanceObserver;
  prepareHostFileMutation?: HostFileMutationPreparer;
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
  if (options.sandbox) {
    const { root, bridge } = options.sandbox;
    return withPatchMemoryWriteProvenance(options.memoryWriteProvenance, {
      readFile: async (filePath) => {
        const buf = await bridge.readFile({ filePath, cwd: root });
        options.signal?.throwIfAborted();
        return decodeUtf8Input(buf, `File ${filePath}`);
      },
      writeFile: async (filePath, content) => {
        options.signal?.throwIfAborted();
        await bridge.writeFile({ filePath, cwd: root, data: content, signal: options.signal });
      },
      createFileExclusive: async (filePath, content) => {
        if (!bridge.createFileExclusive) {
          throw new Error(
            "Sandbox filesystem bridge does not support atomic file creation; refusing to overwrite an existing path.",
          );
        }
        options.signal?.throwIfAborted();
        return await bridge.createFileExclusive({
          filePath,
          cwd: root,
          data: content,
          mkdir: true,
          signal: options.signal,
        });
      },
      remove: async (filePath) => {
        options.signal?.throwIfAborted();
        await bridge.remove({ filePath, cwd: root, force: false, signal: options.signal });
      },
    });
  }

  if (options.workspaceOnly === false) {
    return withPatchMemoryWriteProvenance(options.memoryWriteProvenance, {
      readFile: async (filePath) => {
        const buffer = await fs.readFile(filePath);
        options.signal?.throwIfAborted();
        return decodeUtf8Input(buffer, `File ${filePath}`);
      },
      writeFile: async (filePath, content) => {
        await writeHostFile(filePath, content, options.signal, options.prepareHostFileMutation);
      },
      createFileExclusive: async (filePath, content) => {
        try {
          await using effect = await prepareHostFileMutation(
            options.prepareHostFileMutation,
            options.signal,
          );
          effect.assertCurrent();
          await fs.writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
          return "created";
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            return "exists";
          }
          throw error;
        }
      },
      remove: async (filePath) => {
        await using effect = await prepareHostFileMutation(
          options.prepareHostFileMutation,
          options.signal,
        );
        effect.assertCurrent();
        await fs.rm(filePath);
      },
      mkdirp: async (dir) => {
        await using effect = await prepareHostFileMutation(
          options.prepareHostFileMutation,
          options.signal,
        );
        effect.assertCurrent();
        await fs.mkdir(dir, { recursive: true });
      },
    });
  }

  const containmentRoot = options.root ?? options.cwd;
  const initialRoot = await fsRoot(containmentRoot, {
    assertBeforeMutation: () => options.signal?.throwIfAborted(),
  });
  const roots = new Map([[path.resolve(containmentRoot), initialRoot]]);
  const resolveTarget = async (filePath: string) => {
    const selectedRoot = await resolveHostRootAsync(
      containmentRoot,
      filePath,
      options.strictWorkspaceRoot,
    );
    const relative = toRelativeSandboxPath(selectedRoot, filePath);
    let root = roots.get(selectedRoot);
    if (!root) {
      root = await fsRoot(selectedRoot, {
        assertBeforeMutation: () => options.signal?.throwIfAborted(),
      });
      roots.set(selectedRoot, root);
    }
    const assertBeforeMutation = () => {
      options.signal?.throwIfAborted();
      toRelativeSandboxPath(
        resolveHostWorkspaceRoot(containmentRoot, filePath, options.strictWorkspaceRoot),
        filePath,
      );
    };
    return { root, relative, assertBeforeMutation };
  };
  // Rebase only the admitted root spelling. Root owns parent-alias resolution;
  // absolute paths keep a literal "~" component from becoming home expansion.
  return withPatchMemoryWriteProvenance(options.memoryWriteProvenance, {
    readFile: async (filePath) => {
      const selectedRoot = await resolveHostRootAsync(
        containmentRoot,
        filePath,
        options.strictWorkspaceRoot,
      );
      const opened = await openRootFile({
        absolutePath: filePath,
        rootPath: selectedRoot,
        boundaryLabel: "workspace root",
        symlinks: "follow-parents-within-root",
      });
      assertBoundaryRead(opened, filePath);
      try {
        options.signal?.throwIfAborted();
        const buffer = await readFileDescriptor(opened.fd);
        options.signal?.throwIfAborted();
        return decodeUtf8Input(buffer, `File ${filePath}`);
      } finally {
        await closeFileDescriptor(opened.fd);
      }
    },
    writeFile: async (filePath, content) => {
      const { root, relative, assertBeforeMutation } = await resolveTarget(filePath);
      await using effect = await prepareHostFileMutation(
        options.prepareHostFileMutation,
        options.signal,
      );
      assertBeforeMutation();
      await root
        .write(path.resolve(root.rootReal, relative), content, {
          encoding: "utf8",
          mutationSymlinks: "follow-parents-within-root",
          assertBeforeMutation: () => {
            effect.assertCurrent();
            assertBeforeMutation();
          },
        })
        .catch(rethrowHostMutationError);
    },
    createFileExclusive: async (filePath, content) => {
      try {
        const { root, relative, assertBeforeMutation } = await resolveTarget(filePath);
        await using effect = await prepareHostFileMutation(
          options.prepareHostFileMutation,
          options.signal,
        );
        assertBeforeMutation();
        await root.create(path.resolve(root.rootReal, relative), content, {
          encoding: "utf8",
          mutationSymlinks: "reject",
          assertBeforeMutation: () => {
            effect.assertCurrent();
            assertBeforeMutation();
          },
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
      const { root, relative, assertBeforeMutation } = await resolveTarget(filePath);
      await using effect = await prepareHostFileMutation(
        options.prepareHostFileMutation,
        options.signal,
      );
      assertBeforeMutation();
      // remove requires a relative path; "./" preserves literal tilde names.
      // Omitted mutationSymlinks lets it unlink the final symlink itself.
      await root
        .remove(`./${relative}`, {
          assertBeforeMutation: () => {
            effect.assertCurrent();
            assertBeforeMutation();
          },
        })
        .catch(rethrowHostMutationError);
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
