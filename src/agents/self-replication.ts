/**
 * self-replication.ts
 * Spawn, manage and prune cloned agent workspaces.
 *
 * Self-replication strategy:
 *  1. Clone the best-known config into a new agent directory.
 *  2. Track clones in a manifest at the base state dir.
 *  3. Cap the number of live clones (default MAX_CLONES = 5).
 *  4. Prune the lowest-scoring clones when the cap is reached.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveOpenClawAgentDir } from "./agent-paths.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CloneRecord {
  id: string;
  /** Absolute path to this clone's agent directory */
  dir: string;
  /** Fitness score from last evaluation — higher is better */
  fitness: number;
  /** Generation at which it was spawned */
  generation: number;
  createdAt: number;
  /** ISO timestamp of last fitness update */
  lastEvaluatedAt: number | null;
}

export interface ReplicationManifest {
  clones: CloneRecord[];
  lastUpdatedAt: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_CLONES = 5;
const MANIFEST_FILENAME = "replication-manifest.json";

function resolveManifestPath(): string {
  return path.join(resolveStateDir(), MANIFEST_FILENAME);
}

// ---------------------------------------------------------------------------
// SelfReplicationEngine
// ---------------------------------------------------------------------------

export class SelfReplicationEngine {
  private manifest: ReplicationManifest = { clones: [], lastUpdatedAt: 0 };

  // -------------------------------------------------------------------------
  // Manifest I/O
  // -------------------------------------------------------------------------

  async loadManifest(): Promise<void> {
    try {
      const raw = await fs.readFile(resolveManifestPath(), "utf8");
      this.manifest = JSON.parse(raw) as ReplicationManifest;
    } catch {
      this.manifest = { clones: [], lastUpdatedAt: Date.now() };
    }
  }

  async saveManifest(): Promise<void> {
    const manifestPath = resolveManifestPath();
    await fs.mkdir(path.dirname(manifestPath), { recursive: true, mode: 0o700 });
    this.manifest.lastUpdatedAt = Date.now();
    await fs.writeFile(manifestPath, JSON.stringify(this.manifest, null, 2), {
      mode: 0o600,
    });
  }

  // -------------------------------------------------------------------------
  // Core operations
  // -------------------------------------------------------------------------

  /**
   * Spawn a new agent clone with the given config.
   * Returns the new CloneRecord, or null if the cap is already reached.
   */
  async spawnClone(
    config: OpenClawConfig,
    opts: { generation?: number; fitness?: number } = {},
  ): Promise<CloneRecord | null> {
    await this.loadManifest();

    // Enforce cap before spawning
    if (this.manifest.clones.length >= MAX_CLONES) {
      return null;
    }

    const id = `clone_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const baseDir = resolveStateDir();
    const cloneDir = path.join(baseDir, "clones", id);

    // Create directory structure
    await fs.mkdir(cloneDir, { recursive: true, mode: 0o700 });

    // Write config snapshot
    const configPath = path.join(cloneDir, "config.json");
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });

    // Seed models.json from the primary agent if it exists
    try {
      const primaryModelsPath = path.join(resolveOpenClawAgentDir(), "models.json");
      const primaryModels = await fs.readFile(primaryModelsPath, "utf8");
      await fs.writeFile(path.join(cloneDir, "models.json"), primaryModels, { mode: 0o600 });
    } catch {
      // No models.json yet — clone starts fresh
    }

    const record: CloneRecord = {
      id,
      dir: cloneDir,
      fitness: opts.fitness ?? 0,
      generation: opts.generation ?? 0,
      createdAt: Date.now(),
      lastEvaluatedAt: null,
    };

    this.manifest.clones.push(record);
    await this.saveManifest();

    return record;
  }

  /**
   * Update the fitness score for a specific clone.
   */
  async updateFitness(cloneId: string, fitness: number): Promise<void> {
    await this.loadManifest();
    const clone = this.manifest.clones.find((c) => c.id === cloneId);
    if (clone) {
      clone.fitness = fitness;
      clone.lastEvaluatedAt = Date.now();
      await this.saveManifest();
    }
  }

  /**
   * Remove the lowest-fitness clones, keeping only `keepCount` strongest.
   * Returns the number of clones removed.
   */
  async pruneWeakClones(keepCount: number = MAX_CLONES): Promise<number> {
    await this.loadManifest();

    if (this.manifest.clones.length <= keepCount) {
      return 0;
    }

    // Sort descending by fitness — worst at the end
    const sorted = [...this.manifest.clones].toSorted((a, b) => b.fitness - a.fitness);
    const toRemove = sorted.slice(keepCount);
    const toKeep = sorted.slice(0, keepCount);

    // Delete directories of pruned clones
    for (const clone of toRemove) {
      try {
        await fs.rm(clone.dir, { recursive: true, force: true });
      } catch {
        // Non-fatal: directory may already be gone
      }
    }

    this.manifest.clones = toKeep;
    await this.saveManifest();
    return toRemove.length;
  }

  /**
   * Return the config snapshot loaded from a specific clone's directory.
   */
  async loadCloneConfig(cloneId: string): Promise<OpenClawConfig | null> {
    await this.loadManifest();
    const clone = this.manifest.clones.find((c) => c.id === cloneId);
    if (!clone) {
      return null;
    }
    try {
      const raw = await fs.readFile(path.join(clone.dir, "config.json"), "utf8");
      return JSON.parse(raw) as OpenClawConfig;
    } catch {
      return null;
    }
  }

  /**
   * Promote the best-fitness clone to become the primary config.
   * Overwrites the primary agent's models.json.
   */
  async promotesBestClone(): Promise<CloneRecord | null> {
    await this.loadManifest();
    if (this.manifest.clones.length === 0) {
      return null;
    }

    const best = [...this.manifest.clones].toSorted((a, b) => b.fitness - a.fitness)[0];
    const bestConfig = await this.loadCloneConfig(best.id);
    if (!bestConfig) {
      return null;
    }

    const primaryDir = resolveOpenClawAgentDir();
    await fs.mkdir(primaryDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      path.join(primaryDir, "models.json"),
      JSON.stringify({ providers: bestConfig }, null, 2),
      { mode: 0o600 },
    );

    return best;
  }

  getClones(): Readonly<CloneRecord[]> {
    return this.manifest.clones;
  }

  getBestClone(): CloneRecord | null {
    if (this.manifest.clones.length === 0) {
      return null;
    }
    return [...this.manifest.clones].toSorted((a, b) => b.fitness - a.fitness)[0];
  }

  getMaxClones(): number {
    return MAX_CLONES;
  }
}
