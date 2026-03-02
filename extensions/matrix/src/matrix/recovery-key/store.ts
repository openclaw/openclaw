import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { RECOVERY_KEY_TTL_MS } from "./constants.js";
import type { RecoveryKeyVerificationState } from "./types.js";

const STATE_FILENAME = "recovery-key-verification-state.json";

function defaultState(): RecoveryKeyVerificationState {
  return {
    verified: false,
    deviceId: null,
    verifiedAt: null,
    usedKeyHashes: [],
    backupVersion: null,
  };
}

/**
 * Persistent store for recovery key verification state.
 *
 * Uses atomic write (write to .tmp then rename) for crash safety.
 * Single-process access assumed — no file locking needed.
 */
export class RecoveryKeyStore {
  private state: RecoveryKeyVerificationState;
  private readonly filePath: string;

  constructor(storagePath: string) {
    this.filePath = path.join(storagePath, STATE_FILENAME);
    this.state = defaultState();
  }

  /** Load state from disk. Safe to call multiple times. */
  async initialize(): Promise<void> {
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as RecoveryKeyVerificationState;
      this.state = {
        verified: parsed.verified === true,
        deviceId: typeof parsed.deviceId === "string" ? parsed.deviceId : null,
        verifiedAt: typeof parsed.verifiedAt === "string" ? parsed.verifiedAt : null,
        usedKeyHashes: Array.isArray(parsed.usedKeyHashes) ? parsed.usedKeyHashes : [],
        backupVersion: typeof parsed.backupVersion === "string" ? parsed.backupVersion : null,
      };
    } catch {
      this.state = defaultState();
    }
  }

  /** Get a copy of the current verification state. */
  getState(): RecoveryKeyVerificationState {
    return { ...this.state };
  }

  /** Whether the device is currently verified. */
  get isVerified(): boolean {
    return this.state.verified;
  }

  /**
   * Compute a replay-protection hash for a recovery key + device ID.
   */
  computeKeyHash(recoveryKey: Uint8Array, deviceId: string): string {
    const hmac = crypto.createHmac("sha256", recoveryKey);
    hmac.update(deviceId);
    return hmac.digest("hex");
  }

  /**
   * Check if a recovery key has been used recently (within TTL).
   * Also prunes expired entries.
   */
  isReplayDetected(keyHash: string): boolean {
    const now = Date.now();
    // Prune expired entries
    this.state.usedKeyHashes = this.state.usedKeyHashes.filter((entry) => {
      const usedAt = new Date(entry.usedAt).getTime();
      return now - usedAt < RECOVERY_KEY_TTL_MS;
    });

    return this.state.usedKeyHashes.some((entry) => entry.hash === keyHash);
  }

  /**
   * Record that a recovery key hash has been used.
   */
  markKeyUsed(keyHash: string): void {
    this.state.usedKeyHashes.push({
      hash: keyHash,
      usedAt: new Date().toISOString(),
    });
  }

  /**
   * Mark the device as verified and persist state.
   */
  async markVerified(deviceId: string, backupVersion: string | null): Promise<void> {
    this.state.verified = true;
    this.state.deviceId = deviceId;
    this.state.verifiedAt = new Date().toISOString();
    this.state.backupVersion = backupVersion;
    await this.persist();
  }

  /** Write state to disk atomically (temp file + rename). */
  private async persist(): Promise<void> {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });

    const tmpPath = `${this.filePath}.tmp`;
    const data = JSON.stringify(this.state, null, 2);
    fs.writeFileSync(tmpPath, data, "utf-8");
    fs.renameSync(tmpPath, this.filePath);
  }
}
