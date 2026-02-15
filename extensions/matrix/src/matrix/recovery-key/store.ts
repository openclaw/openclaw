/**
 * Recovery key verification store with persistence support.
 * Manages device verification state and replay protection for recovery keys.
 */

import type { RuntimeLogger } from "openclaw/plugin-sdk";
import fs from "node:fs";
import path from "node:path";
import { lock } from "proper-lockfile";
import type { RecoveryKeyVerificationState } from "./types.js";
import { RECOVERY_KEY_TTL_MS } from "./constants.js";

/**
 * Recovery key verification store managing device state and replay protection.
 */
export class RecoveryKeyStore {
  private deviceVerified = false;
  private deviceId: string | null = null;
  private verifiedAt: string | null = null;
  private usedRecoveryKeys: Array<{ keyHash: string; usedAt: string }> = [];
  private keyBackupVersion: string | null = null;
  private restoredSessionCount = 0;
  private storageDir?: string;

  constructor(private logger?: RuntimeLogger) {}

  /**
   * Initialize store with optional persistence directory.
   * Loads verification state from disk if available.
   */
  async initialize(storageDir?: string): Promise<void> {
    this.storageDir = storageDir;
    if (storageDir) {
      await this.loadPersistedState();
    }
  }

  /**
   * Mark device as verified and persist state.
   */
  async setDeviceVerified(verified: boolean, deviceId: string | null = null): Promise<void> {
    this.deviceVerified = verified;
    this.deviceId = deviceId;
    this.verifiedAt = verified ? new Date().toISOString() : null;
    if (this.storageDir) {
      await this.savePersistedState();
    }
  }

  /**
   * Check if device is verified.
   */
  isDeviceVerified(): boolean {
    return this.deviceVerified;
  }

  /**
   * Get device ID.
   */
  getDeviceId(): string | null {
    return this.deviceId;
  }

  /**
   * Get verification timestamp.
   */
  getVerifiedAt(): string | null {
    return this.verifiedAt;
  }

  /**
   * Mark a recovery key as used (for replay protection).
   */
  async markRecoveryKeyUsed(keyHash: string): Promise<void> {
    this.usedRecoveryKeys.push({
      keyHash,
      usedAt: new Date().toISOString(),
    });

    // Persist to disk
    if (this.storageDir) {
      await this.savePersistedState();
    }
  }

  /**
   * Check if a recovery key has been used within the TTL window (24 hours).
   */
  isRecoveryKeyUsed(keyHash: string): boolean {
    const now = Date.now();
    return this.usedRecoveryKeys.some((entry) => {
      if (entry.keyHash !== keyHash) {
        return false;
      }
      const usedAt = new Date(entry.usedAt).getTime();
      return now - usedAt < RECOVERY_KEY_TTL_MS;
    });
  }

  /**
   * Remove recovery key entries older than 24 hours.
   */
  cleanupExpiredKeys(): void {
    const now = Date.now();
    this.usedRecoveryKeys = this.usedRecoveryKeys.filter((entry) => {
      const usedAt = new Date(entry.usedAt).getTime();
      return now - usedAt < RECOVERY_KEY_TTL_MS;
    });
  }

  /**
   * Update key backup metadata.
   */
  async setKeyBackupInfo(version: string | null, sessionCount: number): Promise<void> {
    this.keyBackupVersion = version;
    this.restoredSessionCount = sessionCount;
    if (this.storageDir) {
      await this.savePersistedState();
    }
  }

  /**
   * Get key backup version.
   */
  getKeyBackupVersion(): string | null {
    return this.keyBackupVersion;
  }

  /**
   * Get restored session count.
   */
  getRestoredSessionCount(): number {
    return this.restoredSessionCount;
  }

  /**
   * Get path to persisted state file.
   */
  private getStatePath(): string | undefined {
    return this.storageDir
      ? path.join(this.storageDir, "recovery-key-verification-state.json")
      : undefined;
  }

  /**
   * Load device verification state from disk.
   */
  private async loadPersistedState(): Promise<void> {
    const statePath = this.getStatePath();
    if (!statePath) {
      return;
    }

    try {
      if (!fs.existsSync(statePath)) {
        return;
      }

      // Acquire file lock
      const release = await lock(statePath, { retries: { retries: 3, minTimeout: 100 } });
      try {
        const data = await fs.promises.readFile(statePath, "utf8");
        const state = JSON.parse(data) as RecoveryKeyVerificationState;
        this.deviceVerified = state.deviceVerified ?? false;
        this.deviceId = state.deviceId ?? null;
        this.verifiedAt = state.verifiedAt ?? null;
        this.keyBackupVersion = state.keyBackupVersion ?? null;
        this.restoredSessionCount = state.restoredSessionCount ?? 0;

        // Load used recovery keys and cleanup expired ones
        const now = Date.now();
        this.usedRecoveryKeys = (state.usedRecoveryKeys ?? []).filter((entry) => {
          const usedAt = new Date(entry.usedAt).getTime();
          return now - usedAt < RECOVERY_KEY_TTL_MS;
        });
      } finally {
        await release();
      }
    } catch (error) {
      this.logger?.warn("matrix: failed to load persisted recovery key verification state", {
        error: String(error),
      });
    }
  }

  /**
   * Save device verification state to disk.
   */
  private async savePersistedState(): Promise<void> {
    const statePath = this.getStatePath();
    if (!statePath) {
      return;
    }

    try {
      // Ensure directory exists
      const dir = path.dirname(statePath);
      if (!fs.existsSync(dir)) {
        await fs.promises.mkdir(dir, { recursive: true });
      }

      // Cleanup expired keys before saving
      this.cleanupExpiredKeys();

      const state: RecoveryKeyVerificationState = {
        deviceVerified: this.deviceVerified,
        deviceId: this.deviceId,
        verifiedAt: this.verifiedAt,
        usedRecoveryKeys: this.usedRecoveryKeys,
        keyBackupVersion: this.keyBackupVersion,
        restoredSessionCount: this.restoredSessionCount,
      };

      // Ensure file exists with placeholder content before locking
      if (!fs.existsSync(statePath)) {
        await fs.promises.writeFile(statePath, "{}", "utf8");
      }

      // Acquire file lock before writing real state
      const release = await lock(statePath, { retries: { retries: 3, minTimeout: 100 } });
      try {
        await fs.promises.writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
      } finally {
        await release();
      }
    } catch (error) {
      this.logger?.warn("matrix: failed to save persisted recovery key verification state", {
        error: String(error),
      });
    }
  }
}

/**
 * Type alias for backward compatibility.
 */
export type VerificationStore = RecoveryKeyStore;

/**
 * Global recovery key verification store instance (singleton).
 * In a production setup, this could be passed via dependency injection.
 */
export const globalRecoveryKeyStore = new RecoveryKeyStore();
