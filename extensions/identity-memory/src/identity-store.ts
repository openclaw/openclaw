/**
 * File-based identity store, consistent with OpenClaw's no-database philosophy.
 * Data persists under the plugin's state directory as JSON files.
 */

import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { UnifiedIdentity, VerificationEntry, PlatformLink } from "./types.js";

/** Manages cross-platform identity data on disk. */
export class IdentityStore {
  private identities = new Map<string, UnifiedIdentity>();
  private platformIndex = new Map<string, string>(); // "platform:userId" → identityId
  private verifications = new Map<string, VerificationEntry>();
  private dataDir: string;
  private dirty = false;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  /** Load persisted state from disk. */
  async load(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    try {
      const raw = await readFile(join(this.dataDir, "identities.json"), "utf-8");
      const data = JSON.parse(raw) as {
        identities: UnifiedIdentity[];
        platformIndex: PlatformLink[];
      };
      for (const identity of data.identities) {
        this.identities.set(identity.id, identity);
      }
      for (const link of data.platformIndex) {
        this.platformIndex.set(`${link.platform}:${link.platformUserId}`, link.identityId);
      }
    } catch {
      // First run or corrupted file — start fresh.
    }
  }

  /** Persist current state to disk. */
  async save(): Promise<void> {
    if (!this.dirty) {
      return;
    }
    await mkdir(this.dataDir, { recursive: true });
    const identities = [...this.identities.values()];
    const platformIndex: PlatformLink[] = [];
    for (const [key, identityId] of this.platformIndex) {
      const [platform, ...rest] = key.split(":");
      platformIndex.push({ platform, platformUserId: rest.join(":"), identityId });
    }
    await writeFile(
      join(this.dataDir, "identities.json"),
      JSON.stringify({ identities, platformIndex }, null, 2),
    );
    this.dirty = false;
  }

  /** Create a new unified identity linked to a platform account. */
  createIdentity(params: {
    name: string;
    platform: string;
    platformUserId: string;
    email?: string;
    phone?: string;
    notes?: string;
  }): UnifiedIdentity {
    const now = new Date().toISOString();
    const identity: UnifiedIdentity = {
      id: randomUUID(),
      name: params.name,
      email: params.email,
      phone: params.phone,
      links: { [params.platform]: params.platformUserId },
      createdAt: now,
      updatedAt: now,
      notes: params.notes,
    };
    this.identities.set(identity.id, identity);
    this.platformIndex.set(`${params.platform}:${params.platformUserId}`, identity.id);
    this.dirty = true;
    return identity;
  }

  /** Link an additional platform account to an existing identity. */
  linkPlatform(identityId: string, platform: string, platformUserId: string): boolean {
    const identity = this.identities.get(identityId);
    if (!identity) {
      return false;
    }
    identity.links[platform] = platformUserId;
    identity.updatedAt = new Date().toISOString();
    this.platformIndex.set(`${platform}:${platformUserId}`, identityId);
    this.dirty = true;
    return true;
  }

  /** Unlink a platform account from an identity. */
  unlinkPlatform(identityId: string, platform: string): boolean {
    const identity = this.identities.get(identityId);
    if (!identity || !identity.links[platform]) {
      return false;
    }
    const userId = identity.links[platform];
    delete identity.links[platform];
    identity.updatedAt = new Date().toISOString();
    this.platformIndex.delete(`${platform}:${userId}`);
    this.dirty = true;
    return true;
  }

  /** Find identity by platform + userId. */
  findByPlatform(platform: string, platformUserId: string): UnifiedIdentity | undefined {
    const identityId = this.platformIndex.get(`${platform}:${platformUserId}`);
    if (!identityId) {
      return undefined;
    }
    return this.identities.get(identityId);
  }

  /** Get identity by ID. */
  getIdentity(identityId: string): UnifiedIdentity | undefined {
    return this.identities.get(identityId);
  }

  /** Search identities by name (case-insensitive substring match). */
  searchByName(query: string): UnifiedIdentity[] {
    const lower = query.toLowerCase();
    return [...this.identities.values()].filter((id) => id.name.toLowerCase().includes(lower));
  }

  /** Get all linked platforms for an identity. */
  getLinkedPlatforms(identityId: string): Record<string, string> {
    return this.identities.get(identityId)?.links ?? {};
  }

  /** Create a verification code for cross-platform linking. */
  createVerification(params: {
    identityId: string;
    fromPlatform: string;
    fromPlatformUserId: string;
    targetPlatform: string;
    targetPlatformUserId: string;
  }): string {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    this.verifications.set(code, {
      code,
      ...params,
      createdAt: Date.now(),
      attempts: 0,
    });
    return code;
  }

  /** Verify a code and complete the linking if valid. */
  verifyCode(
    code: string,
    ttlMs: number,
    maxAttempts: number,
  ): { ok: true; identityId: string } | { ok: false; error: string } {
    const entry = this.verifications.get(code);
    if (!entry) {
      return { ok: false, error: "invalid_code" };
    }
    if (ttlMs === 0 || Date.now() - entry.createdAt > ttlMs) {
      this.verifications.delete(code);
      return { ok: false, error: "expired" };
    }
    // Increment attempt counter on every verification attempt.
    entry.attempts++;
    if (entry.attempts > maxAttempts) {
      this.verifications.delete(code);
      return { ok: false, error: "too_many_attempts" };
    }
    // Consume the code atomically.
    this.verifications.delete(code);
    const linked = this.linkPlatform(
      entry.identityId,
      entry.targetPlatform,
      entry.targetPlatformUserId,
    );
    if (!linked) {
      return { ok: false, error: "identity_not_found" };
    }
    return { ok: true, identityId: entry.identityId };
  }

  /** Clean up expired verification codes. */
  cleanExpiredVerifications(ttlMs: number): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [code, entry] of this.verifications) {
      if (now - entry.createdAt > ttlMs) {
        this.verifications.delete(code);
        cleaned++;
      }
    }
    return cleaned;
  }

  /** Resolve sender: find or create identity for a platform user. */
  resolveSender(
    platform: string,
    platformUserId: string,
    senderName?: string,
  ): { identityId: string; linkedPlatforms: Record<string, string>; isNew: boolean } {
    const existing = this.findByPlatform(platform, platformUserId);
    if (existing) {
      return {
        identityId: existing.id,
        linkedPlatforms: existing.links,
        isNew: false,
      };
    }
    const identity = this.createIdentity({
      name: senderName || `user-${platformUserId.slice(0, 8)}`,
      platform,
      platformUserId,
    });
    return {
      identityId: identity.id,
      linkedPlatforms: identity.links,
      isNew: true,
    };
  }
}
