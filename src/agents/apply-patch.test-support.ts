import path from "node:path";
import { vi } from "vitest";
import type { ApplyPatchFileOptions } from "./apply-patch-file-ops.js";
import type { ApplyPatchSummary } from "./apply-patch.js";
import "./apply-patch.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";

type PatchOptions = Pick<ApplyPatchFileOptions, "cwd" | "sandbox" | "workspaceOnly" | "signal">;

type PatchResult = { summary: ApplyPatchSummary; text: string; noOp?: boolean };

type PatchApi = { applyPatch(input: string, options: PatchOptions): Promise<PatchResult> };

export async function applyPatch(input: string, options: PatchOptions) {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.applyPatchTestApi")
  ];
  if (!api) {
    throw new Error("apply patch test API is unavailable");
  }
  return await (api as PatchApi).applyPatch(input, options);
}

export function createMemoryPatchSandbox(
  initialFiles: Record<string, string | Buffer> = {},
  options: { supportsExclusiveCreate?: boolean; containerRoot?: string } = {},
) {
  const root = options.containerRoot ?? "/sandbox";
  const syntax = root.startsWith("/") ? path.posix : path.win32;
  const resolvePath = (filePath: string) => {
    const resolved = syntax.resolve(root, filePath);
    return syntax === path.win32 ? resolved.toLowerCase() : resolved;
  };
  const files = new Map<string, string | Buffer>(
    Object.entries(initialFiles).map(([filePath, data]) => [resolvePath(filePath), data]),
  );
  const writeFile = vi.fn(async ({ filePath, data }) => {
    files.set(resolvePath(filePath), Buffer.isBuffer(data) ? Buffer.from(data) : data);
  });
  const createFileExclusive = vi.fn(async ({ filePath, data }) => {
    const target = resolvePath(filePath);
    if (files.has(target)) {
      return "exists" as const;
    }
    files.set(target, Buffer.isBuffer(data) ? Buffer.from(data) : data);
    return "created" as const;
  });
  const remove = vi.fn(async ({ filePath }) => void files.delete(resolvePath(filePath)));
  const mkdirp = vi.fn(async () => {});
  const bridge: SandboxFsBridge = {
    resolvePath: ({ filePath }) => ({
      relativePath: syntax.relative(root, resolvePath(filePath)),
      containerPath: resolvePath(filePath),
    }),
    readFile: async ({ filePath }) => Buffer.from(files.get(resolvePath(filePath)) ?? ""),
    writeFile,
    ...(options.supportsExclusiveCreate === false ? {} : { createFileExclusive }),
    remove,
    rename: async ({ from, to }) => {
      const source = resolvePath(from);
      const target = resolvePath(to);
      const data = files.get(source);
      if (data !== undefined) {
        files.set(target, data);
        if (source !== target) {
          files.delete(source);
        }
      }
    },
    stat: async ({ filePath }) => {
      const data = files.get(resolvePath(filePath));
      return data === undefined
        ? null
        : { type: "file", size: Buffer.byteLength(data), mtimeMs: 0 };
    },
    mkdirp,
  };
  return {
    files,
    bridge,
    writeFile,
    createFileExclusive,
    remove,
    mkdirp,
    options: { cwd: "/local/workspace", sandbox: { root: "/local/workspace", bridge } },
  };
}
