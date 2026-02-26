// SelectionReducer — final executor selection from policy evaluations
// Pure function: (intent, cost, capability, failover) → { executor, reason, fallback }
// Phase 5.5: Executor hysteresis + routing metrics

const HYSTERESIS_DELTA = 0.15; // Don't switch if score difference < 15%
const COOLDOWN_MS = 30000; // 30s executor stickiness

class SelectionReducer {
  constructor() {
    // Hysteresis state
    this._lastExecutor = null;
    this._lastSwitchAt = 0;

    // Routing metrics
    this._executorHistory = []; // last 100 decisions
    this._flipCount = 0;
    this._totalDecisions = 0;
  }

  select(intent, cost, capability, failoverEval) {
    // Failover override: if currently failed over, force Claude
    if (failoverEval.action === "failover" || failoverEval.action === "stay_failed_over") {
      return this._record({
        executor: "claude",
        reason: `failover:${failoverEval.reason}`,
        fallback: null,
      });
    }

    // Capability gate: if only one executor is capable
    if (!capability.capable.ollama) {
      return this._record({ executor: "claude", reason: capability.reason, fallback: null });
    }
    if (!capability.capable.claude) {
      return this._record({ executor: "ollama", reason: capability.reason, fallback: null });
    }

    // Cost policy is primary selector
    const preferred = cost.preferred;
    const fallback = cost.fallback;

    let decision;

    // Capability preference can override cost when both are capable
    if (capability.preferred && capability.preferred !== preferred) {
      // Capability says different from cost — use capability for medium complexity
      if (intent.complexity >= 0.4 && intent.complexity <= 0.7) {
        decision = {
          executor: capability.preferred,
          reason: `capability_override:${capability.reason}`,
          fallback: capability.preferred === "ollama" ? "claude" : "ollama",
        };
      }
    }

    if (!decision) {
      decision = {
        executor: preferred,
        reason: `cost:${cost.reason}`,
        fallback,
      };
    }

    // Phase 5.5.1: Executor Hysteresis — prevent oscillation
    if (this._lastExecutor && decision.executor !== this._lastExecutor) {
      const timeSinceSwitch = Date.now() - this._lastSwitchAt;

      // Temporal hysteresis: cooldown period prevents rapid switching
      if (timeSinceSwitch < COOLDOWN_MS) {
        decision = {
          executor: this._lastExecutor,
          reason: `hysteresis:cooldown_${Math.round(timeSinceSwitch / 1000)}s`,
          fallback: decision.fallback,
        };
      }
      // Score-based hysteresis: small differences don't justify switching
      else {
        const scoreDiff = this._estimateScoreDiff(intent, cost, capability);
        if (scoreDiff < HYSTERESIS_DELTA) {
          decision = {
            executor: this._lastExecutor,
            reason: `hysteresis:low_delta_${scoreDiff.toFixed(2)}`,
            fallback: decision.fallback,
          };
        }
      }
    }

    return this._record(decision);
  }

  /**
   * Estimate the confidence difference between executor choices.
   * Used for hysteresis: if the difference is small, don't switch.
   */
  _estimateScoreDiff(intent, cost, capability) {
    // Simple heuristic: complexity distance from thresholds
    // High complexity (>0.6): Claude is clearly better → large diff
    // Low complexity (<0.3): Ollama is clearly better → large diff
    // Medium (0.3-0.6): ambiguous → small diff
    const c = intent.complexity;
    if (c > 0.7 || c < 0.2) {
      return 0.5;
    } // clear winner
    if (c > 0.5) {
      return 0.3 - (0.7 - c) * 0.5;
    } // gradually ambiguous
    return 0.1 + (c - 0.2) * 0.3; // gradually ambiguous
  }

  _record(decision) {
    this._totalDecisions++;

    // Track flips
    if (this._lastExecutor && decision.executor !== this._lastExecutor) {
      this._flipCount++;
      this._lastSwitchAt = Date.now();
    }

    this._lastExecutor = decision.executor;

    // Track history for entropy calculation (keep last 100)
    this._executorHistory.push(decision.executor);
    if (this._executorHistory.length > 100) {
      this._executorHistory.shift();
    }

    return decision;
  }

  // Phase 5.5.2: Routing metrics

  /**
   * Shannon entropy of executor distribution.
   * 0 = always same executor, 1 = perfectly balanced
   */
  getRoutingEntropy() {
    if (this._executorHistory.length < 2) {
      return 0;
    }

    const counts = {};
    for (const e of this._executorHistory) {
      counts[e] = (counts[e] || 0) + 1;
    }

    const total = this._executorHistory.length;
    let entropy = 0;
    for (const count of Object.values(counts)) {
      const p = count / total;
      if (p > 0) {
        entropy -= p * Math.log2(p);
      }
    }

    return entropy;
  }

  /**
   * Executor flip rate — how often we switch between executors.
   * > 30% is a warning sign of policy oscillation.
   */
  getFlipRate() {
    if (this._totalDecisions < 2) {
      return 0;
    }
    return this._flipCount / (this._totalDecisions - 1);
  }

  getStats() {
    return {
      totalDecisions: this._totalDecisions,
      flipCount: this._flipCount,
      flipRate: this.getFlipRate(),
      routingEntropy: this.getRoutingEntropy(),
      lastExecutor: this._lastExecutor,
      historyLength: this._executorHistory.length,
    };
  }
}

module.exports = { SelectionReducer };
