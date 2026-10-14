import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { ClaudeInstallation } from "./cli-installation.types.js";

export const CLAUDE_INSTALLATION_OWNER_MESSAGE =
  "Claude's installation, launcher, and package manager must belong to the Gateway's operating-system user with safe file and directory permissions. Correct the installation permissions or update through its owner, then refresh models.";

/** Layout proves the installer; filesystem ownership proves who may run its updater. */
export async function isClaudeInstallationOwnedByCurrentUser(
  installation: Pick<
    ClaudeInstallation,
    "stableCommand" | "executable" | "ownerRoot" | "managerCommand"
  >,
): Promise<boolean> {
  const uid = process.geteuid?.();
  if (uid === undefined) {
    return false;
  }
  try {
    const aliases = [
      installation.stableCommand,
      installation.executable,
      installation.ownerRoot,
      installation.managerCommand,
    ];
    const leaves = new Set(aliases);
    for (const file of aliases) {
      leaves.add(await fs.realpath(file));
    }
    const paths = new Set<string>();
    const includePath = (file: string) => {
      for (let current = file; ; current = path.dirname(current)) {
        paths.add(current);
        if (path.dirname(current) === current) {
          break;
        }
      }
    };
    for (const file of leaves) {
      includePath(file);
    }
    let symlinkHops = 0;
    const snapshots: Array<{ file: string; link: Stats; target: Stats }> = [];
    for (const file of paths) {
      const link = await fs.lstat(file);
      if (link.isSymbolicLink()) {
        if (++symlinkHops > 40) {
          return false;
        }
        const destination = await fs.readlink(file);
        // realpath hides intermediate owners. Keep every hop and its ancestors,
        // including traversal segments whose preceding directory can itself be a link.
        includePath(
          path.isAbsolute(destination)
            ? destination
            : `${path.dirname(file)}${path.sep}${destination}`,
        );
      }
      const target = link.isSymbolicLink() ? await fs.stat(file) : link;
      for (const stat of [link, target]) {
        if (stat.uid !== uid && (leaves.has(file) || stat.uid !== 0)) {
          return false;
        }
        // POSIX symlink modes do not grant writes. Sticky system scratch ancestors
        // protect their owned children, but installer roots themselves must be private.
        const protectedScratch =
          !leaves.has(file) && stat.isDirectory() && stat.uid === 0 && (stat.mode & 0o1000) !== 0;
        // Homebrew's standard macOS directories are writable by the OS admin
        // group (gid 80). Those administrators already control the host; ordinary
        // groups and writable executable files do not have the same authority.
        const adminDirectory =
          process.platform === "darwin" &&
          stat.isDirectory() &&
          stat.gid === 80 &&
          process.getgroups?.().includes(80);
        const unsafeWrite =
          (stat.mode & 0o002) !== 0 || ((stat.mode & 0o020) !== 0 && !adminDirectory);
        if (!stat.isSymbolicLink() && unsafeWrite && !protectedScratch) {
          return false;
        }
      }
      snapshots.push({ file, link, target });
    }
    for (const snapshot of snapshots.toReversed()) {
      const link = await fs.lstat(snapshot.file);
      const target = link.isSymbolicLink() ? await fs.stat(snapshot.file) : link;
      for (const [before, after] of [
        [snapshot.link, link],
        [snapshot.target, target],
      ] as const) {
        if (
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.uid !== after.uid ||
          before.gid !== after.gid ||
          before.mode !== after.mode
        ) {
          return false;
        }
      }
    }
    return process.geteuid?.() === uid;
  } catch {
    return false;
  }
}
