import fsSync from "node:fs";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import { isSessionLockHeld } from "./session-write-lock.js";

// SessionManager's _persist and _rewriteFile are private, so we access them
// via an untyped record to monkey-patch write guards onto the instance.
type SessionManagerInternal = Record<string, unknown>;

/**
 * Install a write guard on a SessionManager instance that:
 * 1. Checks lock ownership before every write (prevents "ghost writes" after lock loss).
 * 2. Calls fsync after each write to ensure data is flushed to disk.
 *
 * This is a monkey-patch on the SessionManager's internal _persist and _rewriteFile
 * methods. It returns a dispose function that restores the originals.
 */
export function installSessionWriteGuard(params: {
  sessionManager: SessionManager;
  sessionFile: string;
  onLockLost?: () => void;
}): () => void {
  const { sessionManager, sessionFile, onLockLost } = params;

  // Access the internal methods via the instance. SessionManager from pi-coding-agent
  // uses _persist (appendFileSync) and _rewriteFile (writeFileSync) for all writes.
  const sm = sessionManager as unknown as SessionManagerInternal;

  const originalPersist = sm._persist;
  const originalRewriteFile = sm._rewriteFile;

  // Track whether the guard has been disposed.
  let disposed = false;
  // Ensure onLockLost fires at most once to avoid duplicate log/abort calls.
  let lockLostNotified = false;

  function assertLockHeld(): void {
    if (disposed) {
      return;
    }
    if (!isSessionLockHeld(sessionFile)) {
      if (!lockLostNotified) {
        lockLostNotified = true;
        onLockLost?.();
      }
      throw new Error(
        `[session-write-guard] write rejected: session lock no longer held for ${sessionFile}`,
      );
    }
  }

  function fsyncFile(filePath: string): void {
    let fd: number | undefined;
    try {
      fd = fsSync.openSync(filePath, "r");
      fsSync.fsyncSync(fd);
    } catch {
      // Best effort — fsync failure on some filesystems (e.g., network mounts)
      // should not block the write path.
    } finally {
      if (fd !== undefined) {
        try {
          fsSync.closeSync(fd);
        } catch {
          // Ignore close errors.
        }
      }
    }
  }

  if (typeof originalPersist === "function") {
    sm._persist = function guardedPersist(data: string): void {
      assertLockHeld();
      (originalPersist as (data: string) => void).call(sm, data);
      fsyncFile(sessionFile);
    };
  }

  if (typeof originalRewriteFile === "function") {
    sm._rewriteFile = function guardedRewriteFile(content: string): void {
      assertLockHeld();
      (originalRewriteFile as (content: string) => void).call(sm, content);
      fsyncFile(sessionFile);
    };
  }

  return () => {
    disposed = true;
    if (originalPersist) {
      sm._persist = originalPersist;
    }
    if (originalRewriteFile) {
      sm._rewriteFile = originalRewriteFile;
    }
  };
}
