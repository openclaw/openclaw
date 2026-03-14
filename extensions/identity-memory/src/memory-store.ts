/**
 * File-based episodic and semantic memory store.
 * Episodic entries are append-only JSONL; profiles are JSON.
 */

import { randomUUID } from "node:crypto";
import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { EpisodicEntry, UserProfile } from "./types.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertValidIdentityId(identityId: string): void {
  if (!UUID_RE.test(identityId)) {
    throw new Error("Invalid identityId format");
  }
}

export class MemoryStore {
  private profiles = new Map<string, UserProfile>();
  private dataDir: string;
  private profilesDirty = false;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  /** Load profiles from disk. Episodic entries are read on demand. */
  async load(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    try {
      const raw = await readFile(join(this.dataDir, "profiles.json"), "utf-8");
      const profiles = JSON.parse(raw) as UserProfile[];
      for (const p of profiles) {
        this.profiles.set(p.identityId, p);
      }
    } catch {
      // First run.
    }
  }

  /** Persist profiles to disk. */
  async save(): Promise<void> {
    if (!this.profilesDirty) {
      return;
    }
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(
      join(this.dataDir, "profiles.json"),
      JSON.stringify([...this.profiles.values()], null, 2),
    );
    this.profilesDirty = false;
  }

  // ---------------------------------------------------------------------------
  // Episodic Memory (Journal)
  // ---------------------------------------------------------------------------

  /** Append an episodic entry for an identity. */
  async writeEpisodic(params: {
    identityId: string;
    summary: string;
    tags: string[];
    insights?: string[];
    platform?: string;
  }): Promise<EpisodicEntry> {
    assertValidIdentityId(params.identityId);
    const entry: EpisodicEntry = {
      id: randomUUID(),
      identityId: params.identityId,
      summary: params.summary,
      tags: params.tags,
      insights: params.insights,
      platform: params.platform,
      createdAt: new Date().toISOString(),
    };
    const filePath = join(this.dataDir, `episodic-${params.identityId}.jsonl`);
    await appendFile(filePath, JSON.stringify(entry) + "\n");
    return entry;
  }

  /** Read all episodic entries for an identity. */
  async readEpisodic(identityId: string): Promise<EpisodicEntry[]> {
    assertValidIdentityId(identityId);
    try {
      const raw = await readFile(join(this.dataDir, `episodic-${identityId}.jsonl`), "utf-8");
      return raw
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as EpisodicEntry);
    } catch {
      return [];
    }
  }

  /** Search episodic entries by tags and/or keyword. */
  async searchEpisodic(params: {
    identityId: string;
    tags?: string[];
    keyword?: string;
    limit?: number;
  }): Promise<EpisodicEntry[]> {
    const entries = await this.readEpisodic(params.identityId);
    let filtered = entries;

    if (params.tags?.length) {
      const tagSet = new Set(params.tags.map((t) => t.toLowerCase()));
      filtered = filtered.filter((e) => e.tags.some((t) => tagSet.has(t.toLowerCase())));
    }

    if (params.keyword) {
      const kw = params.keyword.toLowerCase();
      filtered = filtered.filter((e) => e.summary.toLowerCase().includes(kw));
    }

    // Return most recent first.
    filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    return filtered.slice(0, params.limit ?? 20);
  }

  /** Count episodic entries for an identity. */
  async countEpisodic(identityId: string): Promise<number> {
    const entries = await this.readEpisodic(identityId);
    return entries.length;
  }

  /** Compress old episodic entries: keep only the most recent N, return removed entries. */
  async compressEpisodic(identityId: string, keepCount: number): Promise<EpisodicEntry[]> {
    assertValidIdentityId(identityId);
    const entries = await this.readEpisodic(identityId);
    if (entries.length <= keepCount) {
      return [];
    }

    // Sort by date ascending, keep newest.
    entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const removed = entries.slice(0, entries.length - keepCount);
    const kept = entries.slice(entries.length - keepCount);

    const filePath = join(this.dataDir, `episodic-${identityId}.jsonl`);
    await writeFile(filePath, kept.map((e) => JSON.stringify(e)).join("\n") + "\n");
    return removed;
  }

  // ---------------------------------------------------------------------------
  // Semantic Memory (User Profiles)
  // ---------------------------------------------------------------------------

  /** Get or create a user profile. */
  getProfile(identityId: string): UserProfile {
    const existing = this.profiles.get(identityId);
    if (existing) {
      return existing;
    }
    const now = new Date().toISOString();
    const profile: UserProfile = {
      identityId,
      name: "",
      preferences: [],
      expertise: [],
      recentTopics: [],
      interactionCount: 0,
      firstSeen: now,
      lastSeen: now,
    };
    this.profiles.set(identityId, profile);
    this.profilesDirty = true;
    return profile;
  }

  /** Update a user profile with partial data. */
  updateProfile(identityId: string, update: Partial<Omit<UserProfile, "identityId">>): UserProfile {
    const profile = this.getProfile(identityId);

    if (update.name !== undefined) {
      profile.name = update.name;
    }
    if (update.preferences?.length) {
      const set = new Set([...profile.preferences, ...update.preferences]);
      profile.preferences = [...set].slice(-50); // Cap at 50.
    }
    if (update.expertise?.length) {
      const set = new Set([...profile.expertise, ...update.expertise]);
      profile.expertise = [...set].slice(-30);
    }
    if (update.recentTopics?.length) {
      profile.recentTopics = [...update.recentTopics, ...profile.recentTopics].slice(0, 10);
    }
    if (update.interactionCount !== undefined) {
      profile.interactionCount = update.interactionCount;
    }

    profile.lastSeen = new Date().toISOString();
    this.profilesDirty = true;
    return profile;
  }

  /** Record an interaction: bump count, update topics, update lastSeen. */
  recordInteraction(identityId: string, topics?: string[]): UserProfile {
    const profile = this.getProfile(identityId);
    profile.interactionCount++;
    profile.lastSeen = new Date().toISOString();

    if (topics?.length) {
      profile.recentTopics = [...topics, ...profile.recentTopics].slice(0, 10);
    }

    this.profilesDirty = true;
    return profile;
  }
}
