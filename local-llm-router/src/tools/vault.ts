/**
 * Credential vault — encrypted storage for service credentials.
 * Stores login details for Tesco, Amazon, email, etc.
 * Uses AES-256-GCM encryption with a master key from env.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

export interface Credential {
  service: string; // "tesco", "amazon", "email-work"
  username: string;
  password: string;
  extra?: Record<string, string>; // Additional fields (2FA secret, etc.)
  updatedAt: string;
}

interface EncryptedStore {
  version: 1;
  credentials: string; // encrypted JSON
  iv: string; // hex
  tag: string; // hex
}

export class Vault {
  private storePath: string;
  private masterKey: Buffer;

  constructor(storePath: string, masterKeyHex?: string) {
    this.storePath = storePath;
    const keyHex = masterKeyHex ?? process.env.VAULT_MASTER_KEY;
    if (!keyHex) {
      throw new Error(
        "VAULT_MASTER_KEY not set. Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
      );
    }
    this.masterKey = Buffer.from(keyHex, "hex");
    if (this.masterKey.length !== KEY_LENGTH) {
      throw new Error(`Master key must be ${KEY_LENGTH} bytes (${KEY_LENGTH * 2} hex chars)`);
    }
  }

  /**
   * Get credentials for a service.
   */
  async get(service: string): Promise<Credential | null> {
    const all = await this.loadAll();
    return all.find((c) => c.service === service) ?? null;
  }

  /**
   * Store or update credentials for a service.
   */
  async set(credential: Credential): Promise<void> {
    const all = await this.loadAll();
    const idx = all.findIndex((c) => c.service === credential.service);
    if (idx >= 0) {
      all[idx] = { ...credential, updatedAt: new Date().toISOString() };
    } else {
      all.push({ ...credential, updatedAt: new Date().toISOString() });
    }
    await this.saveAll(all);
  }

  /**
   * Delete credentials for a service.
   */
  async delete(service: string): Promise<boolean> {
    const all = await this.loadAll();
    const filtered = all.filter((c) => c.service !== service);
    if (filtered.length === all.length) return false;
    await this.saveAll(filtered);
    return true;
  }

  /**
   * List all stored service names (without revealing credentials).
   */
  async listServices(): Promise<string[]> {
    const all = await this.loadAll();
    return all.map((c) => c.service);
  }

  // --- Internal ---

  private async loadAll(): Promise<Credential[]> {
    try {
      const raw = await fs.readFile(this.storePath, "utf-8");
      const store: EncryptedStore = JSON.parse(raw);

      const iv = Buffer.from(store.iv, "hex");
      const tag = Buffer.from(store.tag, "hex");
      const decipher = crypto.createDecipheriv(ALGORITHM, this.masterKey, iv);
      decipher.setAuthTag(tag);

      const decrypted =
        decipher.update(store.credentials, "hex", "utf-8") +
        decipher.final("utf-8");

      return JSON.parse(decrypted) as Credential[];
    } catch (err: any) {
      if (err.code === "ENOENT") {
        return [];
      }
      throw new Error(`Failed to decrypt vault: ${err.message}`);
    }
  }

  private async saveAll(credentials: Credential[]): Promise<void> {
    await fs.mkdir(path.dirname(this.storePath), { recursive: true });

    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, this.masterKey, iv);

    const plaintext = JSON.stringify(credentials);
    const encrypted =
      cipher.update(plaintext, "utf-8", "hex") + cipher.final("hex");
    const tag = cipher.getAuthTag();

    const store: EncryptedStore = {
      version: 1,
      credentials: encrypted,
      iv: iv.toString("hex"),
      tag: tag.toString("hex"),
    };

    await fs.writeFile(this.storePath, JSON.stringify(store, null, 2), "utf-8");
  }
}
