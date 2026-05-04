/**
 * Atomic marker persistence for the MAX polling supervisor (per
 * docs/max-plugin/plan.md §6.1.6 + §8 row 17 + §9 N7).
 *
 * Layout: `~/.openclaw/state/channels/max-messenger/<accountId>.json` storing
 * `{ marker, tokenHash }`. Files are written atomically (`*.tmp` + rename) so
 * a crash mid-write does not corrupt the file.
 *
 * Token-hash invalidation: `load()` compares the stored `tokenHash` to the
 * current one. On mismatch we treat the marker as absent and emit
 * `polling.marker_reset` so the loop replays one batch (dedup absorbs the
 * duplicate). Mirrors the Telegram offset-store pattern in
 * `extensions/telegram/src/update-offset-store.ts:88-94` where a bot-id
 * mismatch triggers the same reset.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeJsonFileAtomically } from "openclaw/plugin-sdk/json-store";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

const STORE_VERSION = 1;
const CHANNEL_ID = "max-messenger";

export type MarkerState = {
  marker: number;
  tokenHash: string;
};

export type MarkerLoadResult = {
  marker?: number;
  /** True when the store had an entry but its tokenHash didn't match. */
  invalidated: boolean;
};

export interface MarkerStore {
  /**
   * Read the persisted marker for this account. When the stored `tokenHash`
   * differs from `currentTokenHash`, returns `{ marker: undefined,
   * invalidated: true }` so the caller can emit `polling.marker_reset` and
   * replay starting from the latest batch.
   */
  load(currentTokenHash: string): Promise<MarkerLoadResult>;
  /** Atomically persist `{ marker, tokenHash }`. */
  set(marker: number, tokenHash: string): Promise<void>;
  /** Remove the marker file. Used by `gateway.logoutAccount`. */
  clear(): Promise<void>;
}

export type MarkerStoreOptions = {
  accountId: string;
  /** Test seam — overrides the default `~/.openclaw/state/channels/max-messenger/`. */
  stateDir?: string;
  /** Process env override; primarily for tests on Windows / containers. */
  env?: NodeJS.ProcessEnv;
};

/**
 * Stable hex digest of the bot token. SHA-256 is overkill for this purpose
 * (we just need a deterministic, non-reversible identity tag), but it's the
 * obvious choice and keeps "what does the tokenHash mean" easy to answer
 * during incident review. The hash is only stored on disk alongside the
 * marker; it is never logged.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function normalizeAccountIdForFilename(accountId: string): string {
  const trimmed = accountId.trim();
  if (!trimmed) {
    return "default";
  }
  // Match Telegram's filename normalization so multi-account migrations stay
  // boring on every bundled channel.
  return trimmed.replace(/[^a-z0-9._-]+/giu, "_");
}

function resolveMarkerPath(opts: MarkerStoreOptions): string {
  const stateDir = opts.stateDir ?? resolveStateDir(opts.env ?? process.env, os.homedir);
  const safeAccount = normalizeAccountIdForFilename(opts.accountId);
  return path.join(stateDir, "channels", CHANNEL_ID, `${safeAccount}.json`);
}

type StoredEntry = {
  version?: number;
  marker?: number;
  tokenHash?: string;
};

function isValidMarker(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function safeParseEntry(raw: string): StoredEntry | null {
  try {
    const parsed = JSON.parse(raw) as StoredEntry;
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function createMarkerStore(opts: MarkerStoreOptions): MarkerStore {
  const filePath = resolveMarkerPath(opts);

  return {
    async load(currentTokenHash) {
      let raw: string;
      try {
        raw = await fs.readFile(filePath, "utf8");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          return { invalidated: false };
        }
        // Surface other read errors so we don't silently lose marker state on
        // (say) a permissions glitch — the loop logs and proceeds without one.
        throw err;
      }

      const parsed = safeParseEntry(raw);
      if (!parsed || !isValidMarker(parsed.marker) || typeof parsed.tokenHash !== "string") {
        // Corrupt or schema-mismatched file. Treat as absent so the loop
        // restarts cleanly.
        return { invalidated: false };
      }
      if (parsed.tokenHash !== currentTokenHash) {
        // Token rotated since the marker was written. Per §8 row 17 / §9 N7
        // we invalidate so the next poll replays one batch; dedup absorbs it.
        return { invalidated: true };
      }
      return { marker: parsed.marker, invalidated: false };
    },
    async set(marker, tokenHash) {
      if (!isValidMarker(marker)) {
        throw new Error(
          `max-messenger marker must be a non-negative safe integer (got ${String(marker)}).`,
        );
      }
      const payload: Required<StoredEntry> = {
        version: STORE_VERSION,
        marker,
        tokenHash,
      };
      await writeJsonFileAtomically(filePath, payload);
    },
    async clear() {
      try {
        await fs.unlink(filePath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          return;
        }
        throw err;
      }
    },
  };
}
