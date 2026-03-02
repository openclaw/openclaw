/**
 * File-based session store for GramJS session strings.
 *
 * Persists StringSession data to ~/.openclaw/credentials/ with secure
 * file permissions (0o600) and atomic writes to prevent corruption.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_CREDENTIALS_DIR = path.join(os.homedir(), ".openclaw", "credentials");
const SESSION_PREFIX = "telegram-userbot-";
const SESSION_SUFFIX = ".session";

export class SessionStore {
  readonly credentialsDir: string;

  constructor(credentialsDir?: string) {
    this.credentialsDir = credentialsDir ?? DEFAULT_CREDENTIALS_DIR;
  }

  /** Returns the full path for a given account's session file. */
  getSessionPath(accountId: string): string {
    return path.join(this.credentialsDir, `${SESSION_PREFIX}${accountId}${SESSION_SUFFIX}`);
  }

  /**
   * Loads a saved session string for the given account.
   * Returns `null` if the session file does not exist.
   */
  async load(accountId: string): Promise<string | null> {
    const sessionPath = this.getSessionPath(accountId);
    try {
      const content = await fs.readFile(sessionPath, "utf8");
      return content.trim();
    } catch (err: unknown) {
      if (isEnoent(err)) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Persists a session string for the given account.
   *
   * Creates the credentials directory (mode 0o700) if missing, writes
   * to a temporary file first, then atomically renames to prevent
   * corruption on crash.
   */
  async save(accountId: string, session: string): Promise<void> {
    const sessionPath = this.getSessionPath(accountId);
    await fs.mkdir(this.credentialsDir, { recursive: true, mode: 0o700 });

    // Atomic write: .tmp -> rename
    const tmpPath = `${sessionPath}.tmp`;
    await fs.writeFile(tmpPath, session, "utf8");
    await fs.chmod(tmpPath, 0o600);
    await fs.rename(tmpPath, sessionPath);
  }

  /**
   * Deletes the session file for the given account.
   * No-op if the file has already been deleted.
   */
  async clear(accountId: string): Promise<void> {
    const sessionPath = this.getSessionPath(accountId);
    try {
      await fs.unlink(sessionPath);
    } catch (err: unknown) {
      if (isEnoent(err)) {
        return;
      }
      throw err;
    }
  }

  /** Checks whether a session file exists without reading its content. */
  async exists(accountId: string): Promise<boolean> {
    const sessionPath = this.getSessionPath(accountId);
    try {
      await fs.access(sessionPath);
      return true;
    } catch {
      return false;
    }
  }
}

/** Type guard for ENOENT filesystem errors. */
function isEnoent(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}
