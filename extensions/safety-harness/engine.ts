import { matchRule, type HarnessRule } from "./rules.js";
import type { HarnessClassification, HarnessTier } from "./types.js";
import { classifyVerb, verbToDefaultTier } from "./verb-classifier.js";

export class RulesEngine {
  constructor(
    private builtinRules: HarnessRule[],
    private operatorRules: HarnessRule[],
    private clientRules: HarnessRule[],
  ) {}

  /**
   * Classify a tool call against all 3 layers.
   * Within each layer, ALL matching rules are evaluated and the most restrictive tier wins (Gap 11).
   * Layers evaluated in order: 1→2→3→verb default.
   */
  classify(toolName: string, params: Record<string, unknown>): HarnessClassification {
    // Layer 1: Built-in (hardcoded floor — cannot be overridden)
    const l1 = this.mostRestrictiveMatch(this.builtinRules, toolName, params);
    if (l1) return { ...l1, layer: 1 };

    // Layer 2: Operator (fleet-wide policy — hot-reloadable)
    const l2 = this.mostRestrictiveMatch(this.operatorRules, toolName, params);
    if (l2) return { ...l2, layer: 2 };

    // Layer 3: Client overrides
    const l3 = this.mostRestrictiveMatch(this.clientRules, toolName, params);
    if (l3) return { ...l3, layer: 3 };

    // No rule matched — classify by verb type
    const verb = classifyVerb(toolName);
    const tier = verbToDefaultTier(verb);
    const reason =
      verb === "unknown" ? `unknown verb — default confirm` : `verb default: ${verb} → ${tier}`;

    return { tier, reason };
  }

  /**
   * Evaluate all matching rules in a layer, return the most restrictive match.
   * Gap 11 fix: block > confirm > allow.
   */
  private mostRestrictiveMatch(
    rules: HarnessRule[],
    toolName: string,
    params: Record<string, unknown>,
  ): Omit<HarnessClassification, "layer"> | null {
    const matches = rules.filter((rule) => matchRule(rule, toolName, params));
    if (matches.length === 0) return null;

    const best = matches.reduce((a, b) => (tierPriority(b.tier) > tierPriority(a.tier) ? b : a));
    return { tier: best.tier, reason: best.reason, rule: best.tool };
  }

  /** Replace operator rules (hot-reload from config webhook). */
  setOperatorRules(rules: HarnessRule[]): void {
    this.operatorRules = rules;
  }

  /** Replace client rules (hot-reload from account page sync). */
  setClientRules(rules: HarnessRule[]): void {
    this.clientRules = rules;
  }
}

/** Tier priority for most-restrictive-wins evaluation (Gap 11). */
function tierPriority(tier: HarnessTier): number {
  switch (tier) {
    case "block":
      return 3;
    case "confirm":
      return 2;
    case "allow":
      return 1;
  }
}
