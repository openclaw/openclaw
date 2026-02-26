// PolicyStateStore — centralized mutable state for all policies
// Policies are pure functions; all mutable counters live here.
// Phase 3.1: Hybrid persistence — debounce 2s + max-delay 5s + snapshot 60s

const fs = require("fs");
const path = require("path");

const SCHEMA_VERSION = 1;
const STATE_DIR = path.join(process.env.HOME || "/root", ".openclaw", "data");
const STATE_PATH = path.join(STATE_DIR, "policy-state.json");
const DEBOUNCE_MS = 2000;
const MAX_DELAY_MS = 5000;
const SNAPSHOT_INTERVAL_MS = 60000;

class PolicyStateStore {
  constructor() {
    // Failover state
    this.failover = {
      consecutiveSuccess: 0,
      consecutiveFailures: 0,
      lastFailureTs: 0,
      lastRecoveryTs: 0,
      p95Latencies: [], // rolling window of last 20 latencies
      isFailedOver: false,
      failoverSince: 0,
    };

    // Cost tracking
    this.cost = {
      ollamaRequests: 0,
      claudeRequests: 0,
      totalRequests: 0,
    };

    // Executor availability
    this.availability = {
      ollama: true,
      claude: true,
    };

    // Persistence state
    this._dirty = false;
    this._firstDirtyAt = null;
    this._debounceTimer = null;
    this._snapshotInterval = null;

    // Restore from disk on construction
    this._restore();

    // Background snapshot every 60s
    this._snapshotInterval = setInterval(() => {
      if (this._dirty) {
        this._flushNow();
      }
    }, SNAPSHOT_INTERVAL_MS);
    if (this._snapshotInterval.unref) {
      this._snapshotInterval.unref();
    }

    // Graceful shutdown
    this._shutdownHandler = () => {
      if (this._dirty) {
        this._flushNow();
      }
    };
    process.on("SIGTERM", this._shutdownHandler);
    process.on("SIGINT", this._shutdownHandler);
  }

  // --- Failover state ---

  recordSuccess(executor, latencyMs) {
    if (executor === "ollama") {
      this.failover.consecutiveSuccess++;
      this.failover.consecutiveFailures = 0;
      this._pushLatency(latencyMs);
    }
    this.cost.totalRequests++;
    this.cost[executor === "ollama" ? "ollamaRequests" : "claudeRequests"]++;
    this._markDirty();
  }

  recordFailure(executor) {
    if (executor === "ollama") {
      this.failover.consecutiveFailures++;
      this.failover.consecutiveSuccess = 0;
      this.failover.lastFailureTs = Date.now();
    }
    this.cost.totalRequests++;
    this._markDirty();
  }

  markFailover() {
    this.failover.isFailedOver = true;
    this.failover.failoverSince = Date.now();
    this.failover.consecutiveSuccess = 0;
    this._markDirty();
  }

  markRecovered() {
    this.failover.isFailedOver = false;
    this.failover.lastRecoveryTs = Date.now();
    this.failover.consecutiveFailures = 0;
    this._markDirty();
  }

  getP95Latency() {
    const arr = this.failover.p95Latencies;
    if (arr.length === 0) {
      return 0;
    }
    const sorted = [...arr].toSorted((a, b) => a - b);
    const idx = Math.floor(sorted.length * 0.95);
    return sorted[Math.min(idx, sorted.length - 1)];
  }

  _pushLatency(ms) {
    this.failover.p95Latencies.push(ms);
    if (this.failover.p95Latencies.length > 20) {
      this.failover.p95Latencies.shift();
    }
  }

  // --- Cost ratio ---

  getOllamaRatio() {
    if (this.cost.totalRequests === 0) {
      return 0;
    }
    return this.cost.ollamaRequests / this.cost.totalRequests;
  }

  getSnapshot() {
    return {
      failover: { ...this.failover, p95: this.getP95Latency() },
      cost: { ...this.cost, ollamaRatio: this.getOllamaRatio() },
      availability: { ...this.availability },
    };
  }

  // --- Hybrid Persistence ---

  _markDirty() {
    this._dirty = true;
    if (!this._firstDirtyAt) {
      this._firstDirtyAt = Date.now();
    }

    // Max-delay ceiling: prevent infinite debounce refresh under high traffic
    if (Date.now() - this._firstDirtyAt > MAX_DELAY_MS) {
      this._flushNow();
      return;
    }

    clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => this._flushNow(), DEBOUNCE_MS);
  }

  _flushNow() {
    clearTimeout(this._debounceTimer);
    this._debounceTimer = null;
    this._dirty = false;
    this._firstDirtyAt = null;
    this._persist();
  }

  _persist() {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      const snapshot = {
        _schemaVersion: SCHEMA_VERSION,
        _persistedAt: new Date().toISOString(),
        failover: { ...this.failover },
        cost: { ...this.cost },
        availability: { ...this.availability },
      };
      const tmp = STATE_PATH + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
      fs.renameSync(tmp, STATE_PATH);
    } catch (e) {
      console.warn("[PolicyStateStore] persist failed:", e.message);
    }
  }

  _restore() {
    try {
      if (!fs.existsSync(STATE_PATH)) {
        return;
      }
      const raw = fs.readFileSync(STATE_PATH, "utf8");
      const data = JSON.parse(raw);

      // Schema version check
      if (data._schemaVersion !== SCHEMA_VERSION) {
        console.warn("[PolicyStateStore] schema version mismatch, starting fresh");
        return;
      }

      // Restore failover state
      if (data.failover) {
        this.failover.consecutiveSuccess = data.failover.consecutiveSuccess || 0;
        this.failover.consecutiveFailures = data.failover.consecutiveFailures || 0;
        this.failover.lastFailureTs = data.failover.lastFailureTs || 0;
        this.failover.lastRecoveryTs = data.failover.lastRecoveryTs || 0;
        this.failover.p95Latencies = Array.isArray(data.failover.p95Latencies)
          ? data.failover.p95Latencies.slice(-20)
          : [];
        this.failover.isFailedOver = data.failover.isFailedOver || false;
        this.failover.failoverSince = data.failover.failoverSince || 0;
      }

      // Restore cost tracking
      if (data.cost) {
        this.cost.ollamaRequests = data.cost.ollamaRequests || 0;
        this.cost.claudeRequests = data.cost.claudeRequests || 0;
        this.cost.totalRequests = data.cost.totalRequests || 0;
      }

      // Restore availability
      if (data.availability) {
        this.availability.ollama = data.availability.ollama !== false;
        this.availability.claude = data.availability.claude !== false;
      }

      console.log(
        `[PolicyStateStore] restored: total=${this.cost.totalRequests} ollama=${this.cost.ollamaRequests} claude=${this.cost.claudeRequests} failedOver=${this.failover.isFailedOver}`,
      );
    } catch (e) {
      console.warn("[PolicyStateStore] restore failed:", e.message);
    }
  }

  destroy() {
    clearTimeout(this._debounceTimer);
    clearInterval(this._snapshotInterval);
    process.removeListener("SIGTERM", this._shutdownHandler);
    process.removeListener("SIGINT", this._shutdownHandler);
    if (this._dirty) {
      this._persist();
    }
  }
}

module.exports = { PolicyStateStore };
