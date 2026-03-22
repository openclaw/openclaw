import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { openBoundaryFile } from "../../infra/boundary-file-read.js";
import { resolveUserPath } from "../../utils.js";
import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_HEARTBEAT_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_USER_FILENAME,
  ensureAgentWorkspace,
} from "../workspace.js";

const SANDBOX_BOOTSTRAP_FILES = [
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_USER_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_HEARTBEAT_FILENAME,
] as const;

const SANDBOX_NON_BOOTSTRAP_SKIP = new Set([
  ...SANDBOX_BOOTSTRAP_FILES,
  ".git",
  ".openclaw",
  "skills",
  "MEMORY.md",
  "memory.md",
  "memory",
]);

const SANDBOX_ALLOWED_AUTHORITY_LINKS = new Set(["README.md", "CLAUDE.md", "docs", "voro-docs"]);

async function copyAuthorityTreeIfMissing(src: string, dest: string) {
  try {
    await fs.access(dest);
    return;
  } catch {
    // missing; continue
  }

  const stat = await fs.lstat(src).catch(() => null);
  if (!stat) {
    return;
  }

  if (stat.isSymbolicLink()) {
    return;
  }

  if (stat.isFile()) {
    await fs.copyFile(src, dest);
    return;
  }

  if (stat.isDirectory()) {
    await fs.mkdir(dest, { recursive: false });
    const entries = await fs.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      await copyAuthorityTreeIfMissing(path.join(src, entry.name), path.join(dest, entry.name));
    }
  }
}

async function materializeExplicitWorkspaceLinks(workspaceDir: string, seedFrom: string) {
  const entries = await fs.readdir(seedFrom, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (
      !entry.isSymbolicLink() ||
      SANDBOX_NON_BOOTSTRAP_SKIP.has(entry.name) ||
      !SANDBOX_ALLOWED_AUTHORITY_LINKS.has(entry.name)
    ) {
      continue;
    }

    const src = path.join(seedFrom, entry.name);
    const dest = path.join(workspaceDir, entry.name);
    const resolved = await fs.realpath(src).catch(() => null);
    if (!resolved) {
      continue;
    }

    await copyAuthorityTreeIfMissing(resolved, dest).catch(() => {
      // Ignore invalid or unreadable explicit links; sandbox seeding should stay best-effort.
    });
  }
}

export async function ensureSandboxWorkspace(
  workspaceDir: string,
  seedFrom?: string,
  skipBootstrap?: boolean,
) {
  await fs.mkdir(workspaceDir, { recursive: true });
  if (seedFrom) {
    const seed = resolveUserPath(seedFrom);
    for (const name of SANDBOX_BOOTSTRAP_FILES) {
      const src = path.join(seed, name);
      const dest = path.join(workspaceDir, name);
      try {
        await fs.access(dest);
      } catch {
        try {
          const opened = await openBoundaryFile({
            absolutePath: src,
            rootPath: seed,
            boundaryLabel: "sandbox seed workspace",
          });
          if (!opened.ok) {
            continue;
          }
          try {
            const content = syncFs.readFileSync(opened.fd, "utf-8");
            await fs.writeFile(dest, content, { encoding: "utf-8", flag: "wx" });
          } finally {
            syncFs.closeSync(opened.fd);
          }
        } catch {
          // ignore missing seed file
        }
      }
    }
    await materializeExplicitWorkspaceLinks(workspaceDir, seed);
  }
  await ensureAgentWorkspace({
    dir: workspaceDir,
    ensureBootstrapFiles: !skipBootstrap,
  });
}
