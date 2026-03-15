/**
 * Homeostatic Token Budget Management System
 *
 * This module implements a metabolic token economy that dynamically adjusts
 * context window allocation based on conversation patterns, cognitive load,
 * and information value. It maintains homeostasis by balancing short-term
 * working memory needs with long-term context preservation.
 */

export interface TokenBudget {
  /** Total available tokens for the session */
  total: number;
  /** Currently allocated tokens */
  allocated: number;
  /** Reserved tokens for critical operations */
  reserved: number;
  /** Metabolic rate (tokens per minute) */
  metabolicRate: number;
}

export interface MetabolicState {
  /** Current cognitive load (0-1) */
  cognitiveLoad: number;
  /** Information density score */
  informationDensity: number;
  /** Conversation momentum */
  momentum: number;
  /** Time since last significant context change */
  stabilityPeriod: number;
}

export interface PruningDecision {
  /** Whether to prune context */
  shouldPrune: boolean;
  /** Amount to prune (tokens) */
  pruneAmount: number;
  /** Priority scores for different context segments */
  priorities: Map<string, number>;
  /** Metabolic adjustment factor */
  adjustmentFactor: number;
}

export class TokenMetabolismSystem {
  private budget: TokenBudget;
  private state: MetabolicState;
  private readonly homeostasisThreshold = 0.8;
  private readonly metabolicBaseline = 100; // tokens per minute

  constructor(initialBudget: number) {
    this.budget = {
      total: initialBudget,
      allocated: 0,
      reserved: Math.floor(initialBudget * 0.1), // 10% reserved
      metabolicRate: this.metabolicBaseline,
    };

    this.state = {
      cognitiveLoad: 0.1,
      informationDensity: 0.5,
      momentum: 0.0,
      stabilityPeriod: 0,
    };
  }

  /**
   * Calculate metabolic rate based on current state
   */
  private calculateMetabolicRate(): number {
    const baseRate = this.metabolicBaseline;
    const loadMultiplier = 1 + this.state.cognitiveLoad * 0.5;
    const densityMultiplier = 1 + this.state.informationDensity * 0.3;
    const momentumMultiplier = 1 + Math.abs(this.state.momentum) * 0.2;

    return Math.floor(baseRate * loadMultiplier * densityMultiplier * momentumMultiplier);
  }

  /**
   * Update metabolic state based on conversation dynamics
   */
  updateState(
    newCognitiveLoad: number,
    newInformationDensity: number,
    conversationMomentum: number,
    timeDelta: number,
  ): void {
    this.state.cognitiveLoad = Math.max(0, Math.min(1, newCognitiveLoad));
    this.state.informationDensity = Math.max(0, Math.min(1, newInformationDensity));
    this.state.momentum = conversationMomentum;
    this.state.stabilityPeriod += timeDelta;

    this.budget.metabolicRate = this.calculateMetabolicRate();
  }

  /**
   * Determine if homeostasis requires context pruning
   */
  assessHomeostasis(): PruningDecision {
    const utilizationRatio = this.budget.allocated / (this.budget.total - this.budget.reserved);
    const metabolicPressure = this.budget.metabolicRate / this.metabolicBaseline;

    const shouldPrune = utilizationRatio > this.homeostasisThreshold || metabolicPressure > 1.5;

    let pruneAmount = 0;
    if (shouldPrune) {
      // Calculate adaptive pruning amount
      const excessRatio = Math.max(0, utilizationRatio - this.homeostasisThreshold);
      pruneAmount = Math.floor(this.budget.allocated * excessRatio * 0.3);
    }

    // Calculate segment priorities (simplified)
    const priorities = new Map<string, number>();
    priorities.set("recent", 0.9);
    priorities.set("important", 0.8);
    priorities.set("background", 0.3);

    return {
      shouldPrune,
      pruneAmount,
      priorities,
      adjustmentFactor: metabolicPressure,
    };
  }

  /**
   * Allocate tokens for new content
   */
  allocateTokens(amount: number): boolean {
    const available = this.budget.total - this.budget.reserved - this.budget.allocated;
    if (amount <= available) {
      this.budget.allocated += amount;
      return true;
    }
    return false;
  }

  /**
   * Release tokens from pruned content
   */
  releaseTokens(amount: number): void {
    this.budget.allocated = Math.max(0, this.budget.allocated - amount);
  }

  /**
   * Get current budget status
   */
  getBudgetStatus(): TokenBudget {
    return { ...this.budget };
  }

  /**
   * Get current metabolic state
   */
  getMetabolicState(): MetabolicState {
    return { ...this.state };
  }

  /**
   * Reset metabolic state (for testing or session restart)
   */
  reset(): void {
    this.state = {
      cognitiveLoad: 0.1,
      informationDensity: 0.5,
      momentum: 0.0,
      stabilityPeriod: 0,
    };
    this.budget.metabolicRate = this.metabolicBaseline;
  }
}
