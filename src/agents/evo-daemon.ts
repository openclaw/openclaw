/**
 * evo-daemon.ts
 * Autonomous scheduler that coordinates self-repair, self-improvement,
 * and self-replication at configurable intervals.
 *
 * Design constraints:
 *  - Single-instance per machine (lock file guard).
 *  - All operations are fire-and-forget; the daemon never crashes the host.
 *  - State is persisted to daemon-status.json for CLI inspection.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { readConfigFileSnapshot } from "../config/io.js";
import { resolveStateDir } from "../config/paths.js";
import type { EvolutionaryEngine } from "./self-evolution.js";
import { getSharedMetricsCollector } from "./self-metrics.js";
import type { SelfRepairEngine } from "./self-repair.js";
import type { SelfReplicationEngine } from "./self-replication.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DaemonConfig {
  /** How often to run self-repair (ms). Default: 5 minutes */
  repairIntervalMs: number;
  /** How often to run one generation of evolution (ms). Default: 1 hour */
  evolveIntervalMs: number;
  /** How often to check replication/prune (ms). Default: 2 hours */
  replicationIntervalMs: number;
}

export interface DaemonStatus {
  running: boolean;
  pid: number | null;
  startedAt: number | null;
  lastRepairAt: number | null;
  lastEvolveAt: number | null;
  lastReplicationAt: number | null;
  repairCount: number;
  evolveCount: number;
  replicationCount: number;
  currentGeneration: number;
  bestFitness: number | null;
  cloneCount: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: DaemonConfig = {
  repairIntervalMs: 5 * 60 * 1_000, // 5 min
  evolveIntervalMs: 60 * 60 * 1_000, // 1 hour
  replicationIntervalMs: 2 * 60 * 60 * 1_000, // 2 hours
};

const LOCK_FILENAME = "daemon.lock";
const STATUS_FILENAME = "daemon-status.json";

function resolveLockPath(): string {
  return path.join(resolveStateDir(), LOCK_FILENAME);
}

function resolveStatusPath(): string {
  return path.join(resolveStateDir(), STATUS_FILENAME);
}

// ---------------------------------------------------------------------------
// EvoDaemon
// ---------------------------------------------------------------------------

export class EvoDaemon {
  private config: DaemonConfig;
  private status: DaemonStatus;
  private repairTimer: ReturnType<typeof setInterval> | null = null;
  private evolveTimer: ReturnType<typeof setInterval> | null = null;
  private replicationTimer: ReturnType<typeof setInterval> | null = null;

  // Lazy-loaded engines (injected or instantiated on first use)
  private _repairEngine: SelfRepairEngine | null = null;
  private _evolutionEngine: EvolutionaryEngine | null = null;
  private _replicationEngine: SelfReplicationEngine | null = null;

  constructor(cfg: Partial<DaemonConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...cfg };
    this.status = {
      running: false,
      pid: null,
      startedAt: null,
      lastRepairAt: null,
      lastEvolveAt: null,
      lastReplicationAt: null,
      repairCount: 0,
      evolveCount: 0,
      replicationCount: 0,
      currentGeneration: 0,
      bestFitness: null,
      cloneCount: 0,
    };
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Start the daemon. Returns false if another instance is already running. */
  async start(): Promise<boolean> {
    if (!(await this.acquireLock())) {
      return false;
    }

    this.status.running = true;
    this.status.pid = process.pid;
    this.status.startedAt = Date.now();
    await this.saveStatus();

    // Initialise engines
    await this.initEngines();

    // Schedule loops
    this.repairTimer = setInterval(() => void this.runRepairCycle(), this.config.repairIntervalMs);
    this.evolveTimer = setInterval(() => void this.runEvolveCycle(), this.config.evolveIntervalMs);
    this.replicationTimer = setInterval(
      () => void this.runReplicationCycle(),
      this.config.replicationIntervalMs,
    );

    // First pass immediately
    await this.runRepairCycle();

    return true;
  }

  /** Gracefully stop the daemon. */
  async stop(): Promise<void> {
    if (this.repairTimer) {
      clearInterval(this.repairTimer);
    }
    if (this.evolveTimer) {
      clearInterval(this.evolveTimer);
    }
    if (this.replicationTimer) {
      clearInterval(this.replicationTimer);
    }

    this.status.running = false;
    await this.saveStatus();
    await this.releaseLock();
  }

  // -------------------------------------------------------------------------
  // Scheduled cycles
  // -------------------------------------------------------------------------

  private async runRepairCycle(): Promise<void> {
    try {
      if (!this._repairEngine) {
        return;
      }
      await this._repairEngine.loadConfig();
      const result = await this._repairEngine.repair();
      if (result.repairs.length > 0) {
        await this._repairEngine.saveRepairedConfig();
      }
      this.status.lastRepairAt = Date.now();
      this.status.repairCount++;
      await this.saveStatus();
    } catch {
      // Never propagate — daemon must stay alive
    }
  }

  private async runEvolveCycle(): Promise<void> {
    try {
      if (!this._evolutionEngine) {
        return;
      }
      const metrics = getSharedMetricsCollector().compute();
      const best = await this._evolutionEngine.evolveWithMetrics(metrics);
      if (best) {
        this.status.bestFitness = best.fitness;
        this.status.currentGeneration = this._evolutionEngine.getGeneration();
        if (best.fitness > 0.8) {
          // Auto-save when a sufficiently good config is found
          await this._evolutionEngine.saveBestConfig();
        }
      }
      this.status.lastEvolveAt = Date.now();
      this.status.evolveCount++;
      await this.saveStatus();
    } catch {
      // Never propagate
    }
  }

  private async runReplicationCycle(): Promise<void> {
    try {
      if (!this._evolutionEngine || !this._replicationEngine) {
        return;
      }

      const best = this._evolutionEngine.getBestIndividual();
      if (!best || best.fitness < 0.7) {
        return;
      } // Only replicate genuinely good configs

      await this._replicationEngine.loadManifest();
      const clones = this._replicationEngine.getClones();

      // Spawn if under cap
      if (clones.length < this._replicationEngine.getMaxClones()) {
        await this._replicationEngine.spawnClone(best.config, {
          generation: best.generation,
          fitness: best.fitness,
        });
      } else {
        // Otherwise prune and make room for a new spawn
        await this._replicationEngine.pruneWeakClones(this._replicationEngine.getMaxClones() - 1);
        await this._replicationEngine.spawnClone(best.config, {
          generation: best.generation,
          fitness: best.fitness,
        });
      }

      this.status.cloneCount = this._replicationEngine.getClones().length;
      this.status.lastReplicationAt = Date.now();
      this.status.replicationCount++;
      await this.saveStatus();
    } catch {
      // Never propagate
    }
  }

  // -------------------------------------------------------------------------
  // Engine initialisation
  // -------------------------------------------------------------------------

  private async initEngines(): Promise<void> {
    const [{ SelfRepairEngine }, { EvolutionaryEngine }, { SelfReplicationEngine }] =
      await Promise.all([
        import("./self-repair.js"),
        import("./self-evolution.js"),
        import("./self-replication.js"),
      ]);

    this._repairEngine = new SelfRepairEngine();

    const snapshot = await readConfigFileSnapshot().catch(() => null);
    const initialConfig = snapshot?.config ?? {};

    const engine = new EvolutionaryEngine();
    await engine.initialize(initialConfig);
    this._evolutionEngine = engine;

    this._replicationEngine = new SelfReplicationEngine();
    await this._replicationEngine.loadManifest();
  }

  // -------------------------------------------------------------------------
  // Lock file helpers
  // -------------------------------------------------------------------------

  private async acquireLock(): Promise<boolean> {
    const lockPath = resolveLockPath();
    try {
      await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
      // O_EXCL ensures atomic creation — fails if file already exists
      const handle = await fs.open(lockPath, "wx");
      await handle.writeFile(String(process.pid));
      await handle.close();
      return true;
    } catch {
      // Lock exists — check if the PID is still alive
      try {
        const pidStr = await fs.readFile(lockPath, "utf8");
        const pid = parseInt(pidStr.trim(), 10);
        if (!isNaN(pid)) {
          try {
            process.kill(pid, 0); // Signal 0 = check existence only
            return false; // Another live process owns the lock
          } catch {
            // Stale lock — remove and retry
            await fs.unlink(lockPath);
            return this.acquireLock();
          }
        }
      } catch {
        /* ignore */
      }
      return false;
    }
  }

  private async releaseLock(): Promise<void> {
    try {
      await fs.unlink(resolveLockPath());
    } catch {
      /* ignore */
    }
  }

  // -------------------------------------------------------------------------
  // Status helpers
  // -------------------------------------------------------------------------

  private async saveStatus(): Promise<void> {
    try {
      const statusPath = resolveStatusPath();
      await fs.mkdir(path.dirname(statusPath), { recursive: true, mode: 0o700 });
      await fs.writeFile(statusPath, JSON.stringify(this.status, null, 2), { mode: 0o600 });
    } catch {
      /* ignore */
    }
  }

  getStatus(): DaemonStatus {
    return { ...this.status };
  }
}

// ---------------------------------------------------------------------------
// Static helpers for CLI
// ---------------------------------------------------------------------------

export async function readDaemonStatus(): Promise<DaemonStatus | null> {
  try {
    const raw = await fs.readFile(resolveStatusPath(), "utf8");
    return JSON.parse(raw) as DaemonStatus;
  } catch {
    return null;
  }
}

export async function isDaemonRunning(): Promise<boolean> {
  const lockPath = resolveLockPath();
  try {
    const pidStr = await fs.readFile(lockPath, "utf8");
    const pid = parseInt(pidStr.trim(), 10);
    if (isNaN(pid)) {
      return false;
    }
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
