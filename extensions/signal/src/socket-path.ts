import { lstat, mkdir, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";

function socketOwner(socketPath: string): number {
  if (process.platform === "win32" || !process.getuid) {
    throw new Error("Signal UNIX socket transport requires a POSIX host");
  }
  if (
    !path.isAbsolute(socketPath) ||
    path.normalize(socketPath) !== socketPath ||
    socketPath.includes("\0")
  ) {
    throw new Error("Signal socketPath must be a normalized absolute path without NUL bytes");
  }
  // Keep within the smaller sockaddr_un limit used by supported POSIX hosts.
  if (Buffer.byteLength(socketPath) > 103) {
    throw new Error("Signal socketPath must be at most 103 UTF-8 bytes");
  }
  return process.getuid();
}

async function validateDirectories(directory: string, uid: number, privateParent: boolean) {
  const parts = path.resolve(directory).split(path.sep).filter(Boolean);
  let current = path.parse(directory).root;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Signal socketPath must not traverse symlinks or non-directories");
    }
    if (stat.uid !== uid && stat.uid !== 0) {
      throw new Error("Signal socketPath ancestors must belong to the current user or root");
    }
    // A root-owned sticky temporary directory protects the user's private child from
    // replacement by another uid. Other writable ancestors cannot preserve ownership.
    if ((stat.mode & 0o022) !== 0 && !(stat.uid === 0 && (stat.mode & 0o1000) !== 0)) {
      throw new Error("Signal socketPath ancestors must not be writable by other users");
    }
    if (privateParent && current === path.resolve(directory)) {
      if (stat.uid !== uid || (stat.mode & 0o777) !== 0o700) {
        throw new Error("Signal socketPath parent must belong to the current user with mode 0700");
      }
    }
  }
  if (privateParent && parts.length === 0) {
    throw new Error("Signal socketPath requires a private parent directory");
  }
}

/** Validate the OS-user boundary before every connection, not only at startup. */
async function validateSignalSocketPath(socketPath: string): Promise<void> {
  const uid = socketOwner(socketPath);
  await validateDirectories(path.dirname(socketPath), uid, true);
}

export async function assertSignalSocketEndpoint(socketPath: string): Promise<void> {
  await validateSignalSocketPath(socketPath);
  const stat = await lstat(socketPath);
  if (!stat.isSocket() || stat.uid !== socketOwner(socketPath)) {
    throw new Error("Signal socketPath must name a socket owned by the current user");
  }
}

async function isStaleSocket(socketPath: string, abortSignal?: AbortSignal): Promise<boolean> {
  abortSignal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const timer = setTimeout(
      () => finish(new Error("Signal socket ownership probe timed out")),
      1_000,
    );
    const onAbort = () => finish(new Error("Signal socket ownership probe aborted"));
    function finish(error?: Error, stale = false) {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
      socket.destroy();
      if (error) {
        reject(error);
      } else {
        resolve(stale);
      }
    }
    socket.once("connect", () => finish());
    socket.once("error", (error) => {
      if ("code" in error && error.code === "ECONNREFUSED") {
        finish(undefined, true);
      } else {
        finish(error);
      }
    });
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Recover crash leftovers without unlinking a live or replaced endpoint. */
export async function prepareSignalSocketPath(
  socketPath: string,
  abortSignal?: AbortSignal,
): Promise<void> {
  const uid = socketOwner(socketPath);
  abortSignal?.throwIfAborted();
  const parent = path.dirname(socketPath);
  await validateDirectories(path.dirname(parent), uid, false);
  try {
    await mkdir(parent, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
      throw error;
    }
  }
  await validateSignalSocketPath(socketPath);
  let existing;
  try {
    existing = await lstat(socketPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (
    existing.isSocket() &&
    existing.uid === uid &&
    (await isStaleSocket(socketPath, abortSignal))
  ) {
    // The private directory excludes other OS users. Revalidate after the awaited probe
    // so a concurrent same-owner daemon replacement is never deliberately removed.
    await validateSignalSocketPath(socketPath);
    const current = await lstat(socketPath);
    abortSignal?.throwIfAborted();
    if (
      current.isSocket() &&
      current.uid === uid &&
      current.dev === existing.dev &&
      current.ino === existing.ino
    ) {
      await unlink(socketPath);
      return;
    }
    throw new Error("Signal socketPath changed during its ownership probe; retry startup");
  }
  throw new Error(
    "Signal socketPath already exists; stop its owner or choose a different socket path before starting",
  );
}
