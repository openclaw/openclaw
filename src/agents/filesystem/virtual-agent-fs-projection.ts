import hostFs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { VirtualAgentFs } from "./agent-filesystem.js";

export type VirtualAgentFsProjection = {
  root: string;
  cleanup: () => Promise<void>;
  syncBack: () => Promise<void>;
  resolveWorkdir: (workdir?: string) => Promise<string>;
};

function normalizeVfsPath(input?: string): string {
  if (!input?.trim() || input.trim() === ".") {
    return "/";
  }
  if (input.includes("\0")) {
    throw new Error("VFS path must not contain NUL bytes.");
  }
  const normalized = path.posix.normalize(`/${input}`).replace(/\/+$/u, "");
  return normalized || "/";
}

function hostPathFor(projectedRoot: string, vfsPath: string): string {
  const normalized = normalizeVfsPath(vfsPath);
  if (normalized === "/") {
    return projectedRoot;
  }
  return path.join(projectedRoot, ...normalized.slice(1).split("/"));
}

function vfsPathFor(projectedRoot: string, hostPath: string): string {
  const relative = path.relative(projectedRoot, hostPath);
  if (!relative) {
    return "/";
  }
  return normalizeVfsPath(relative.split(path.sep).join(path.posix.sep));
}

async function walkProjectedFiles(projectedRoot: string): Promise<
  Array<{
    hostPath: string;
    vfsPath: string;
    kind: "directory" | "file";
  }>
> {
  const entries: Array<{
    hostPath: string;
    vfsPath: string;
    kind: "directory" | "file";
  }> = [];
  const visit = async (dir: string) => {
    for (const entry of await hostFs.readdir(dir, { withFileTypes: true })) {
      const hostPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        entries.push({ hostPath, vfsPath: vfsPathFor(projectedRoot, hostPath), kind: "directory" });
        await visit(hostPath);
      } else if (entry.isFile()) {
        entries.push({ hostPath, vfsPath: vfsPathFor(projectedRoot, hostPath), kind: "file" });
      }
    }
  };
  await visit(projectedRoot);
  return entries;
}

export async function createVirtualAgentFsProjection(
  vfs: VirtualAgentFs,
): Promise<VirtualAgentFsProjection> {
  const root = await hostFs.mkdtemp(path.join(os.tmpdir(), "openclaw-vfs-exec-"));
  const exportedEntries = vfs.export("/", { recursive: true }).toSorted((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "directory" ? -1 : 1;
    }
    return left.path.localeCompare(right.path);
  });

  for (const entry of exportedEntries) {
    const hostPath = hostPathFor(root, entry.path);
    if (entry.kind === "directory") {
      await hostFs.mkdir(hostPath, { recursive: true });
      continue;
    }
    await hostFs.mkdir(path.dirname(hostPath), { recursive: true });
    const content = entry.contentBase64
      ? Buffer.from(entry.contentBase64, "base64")
      : vfs.readFile(entry.path);
    await hostFs.writeFile(hostPath, content);
  }

  const syncBack = async () => {
    const previousPaths = new Set(
      vfs
        .list("/", { recursive: true })
        .map((entry) => entry.path)
        .filter((entryPath) => entryPath !== "/"),
    );
    const projectedEntries = await walkProjectedFiles(root);
    const currentPaths = new Set(projectedEntries.map((entry) => entry.vfsPath));

    for (const entry of projectedEntries) {
      if (entry.kind === "directory") {
        vfs.mkdir(entry.vfsPath);
      } else {
        vfs.writeFile(entry.vfsPath, await hostFs.readFile(entry.hostPath));
      }
    }

    for (const removedPath of [...previousPaths]
      .filter((entryPath) => !currentPaths.has(entryPath))
      .toSorted((left, right) => right.length - left.length)) {
      vfs.remove(removedPath, { recursive: true });
    }
  };

  return {
    root,
    cleanup: () => hostFs.rm(root, { recursive: true, force: true }),
    syncBack,
    resolveWorkdir: async (workdir?: string) => {
      const resolved = hostPathFor(root, normalizeVfsPath(workdir));
      await hostFs.mkdir(resolved, { recursive: true });
      return resolved;
    },
  };
}
