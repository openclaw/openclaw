// DecisionEngine — policy orchestrator (< 100 lines)
// No if-else business logic. Only policy composition.
// All routing decisions flow through policies.

const { IntentPolicy } = require("./policies/intent-policy.cjs");
const { CostPolicy } = require("./policies/cost-policy.cjs");
const { CapabilityPolicy } = require("./policies/capability-policy.cjs");
const { FailoverPolicy } = require("./policies/failover-policy.cjs");
const { SelectionReducer } = require("./policies/selection-reducer.cjs");
const { PolicyStateStore } = require("./infra/policy-state-store.cjs");

const FAST_DECISION_TIMEOUT = 75; // ms — local decisions must be within this

class DecisionEngine {
  constructor(options = {}) {
    this.intentPolicy = options.intentPolicy || new IntentPolicy();
    this.costPolicy = options.costPolicy || new CostPolicy();
    this.capabilityPolicy = options.capabilityPolicy || new CapabilityPolicy();
    this.failoverPolicy = options.failoverPolicy || new FailoverPolicy();
    this.reducer = options.reducer || new SelectionReducer();
    this.stateStore = options.stateStore || new PolicyStateStore();
  }

  decide(ctx, trace) {
    const start = Date.now();

    // 1. Intent classification (from background hint, not blocking)
    const intent = this.intentPolicy.evaluate(ctx);

    // 2. Get state snapshot (immutable for this decision)
    const state = this.stateStore.getSnapshot();

    // 3. Evaluate policies
    const cost = this.costPolicy.evaluate(intent, state);
    const capability = this.capabilityPolicy.match(intent);
    const failoverEval = this.failoverPolicy.evaluate(state);

    // 4. Reduce to final decision
    const decision = this.reducer.select(intent, cost, capability, failoverEval);

    const decisionMs = Date.now() - start;

    // Record in trace
    if (trace) {
      trace.decision_ms = decisionMs;
      trace.spans.push({
        stage: "decision_engine",
        ms: decisionMs,
        intent: intent.intent,
        complexity: intent.complexity,
        executor: decision.executor,
        reason: decision.reason,
        intent_source: intent.source,
        intent_method: intent.method,
        intent_authoritative: intent.authoritative,
      });
    }

    return {
      ...decision,
      intent,
      decisionMs,
      withinBudget: decisionMs < FAST_DECISION_TIMEOUT,
    };
  }

  // Record outcome for state updates
  recordSuccess(executor, latencyMs) {
    this.stateStore.recordSuccess(executor, latencyMs);
  }

  recordFailure(executor) {
    this.stateStore.recordFailure(executor);

    // Check if we need to mark failover
    const state = this.stateStore.getSnapshot();
    if (this.failoverPolicy.shouldFailover(state)) {
      this.stateStore.markFailover();
    }
  }

  // Check if we should recover from failover
  checkRecovery() {
    const state = this.stateStore.getSnapshot();
    if (this.failoverPolicy.canFailback(state)) {
      this.stateStore.markRecovered();
      return true;
    }
    return false;
  }

  getStats() {
    return {
      ...this.stateStore.getSnapshot(),
      routing: this.reducer.getStats ? this.reducer.getStats() : {},
    };
  }
}

module.exports = { DecisionEngine, FAST_DECISION_TIMEOUT };
