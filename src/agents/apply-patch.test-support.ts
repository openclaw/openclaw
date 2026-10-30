import path from "node:path";
import { vi } from "vitest";
import { createApplyPatchTool } from "./apply-patch.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";

export function applyPatch(input: string, options: Parameters<typeof createApplyPatchTool>[0]) {
  return createApplyPatchTool(options).execute("patch-test", { input });
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
