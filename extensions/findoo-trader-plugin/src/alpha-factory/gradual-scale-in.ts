/**
 * Gradual Scale-In: 3-phase capital ramp for newly promoted strategies.
 *
 * Phase 1 (25%) → Phase 2 (50%) → Phase 3 (100%).
 * Each phase must maintain Sharpe > 0 for at least 7 days to advance.
 */

import type { ScaleInState } from "./types.js";

const PHASE_CAPITAL: Record<number, number> = { 1: 0.25, 2: 0.5, 3: 1.0 };
const MIN_PHASE_DAYS = 7;

export class GradualScaleIn {
  private states = new Map<string, ScaleInState>();

  initiate(strategyId: string): ScaleInState {
    const state: ScaleInState = {
      phase: 1,
      phaseStartDate: Date.now(),
      capitalPct: PHASE_CAPITAL[1],
      phaseSharpe: 0,
    };
    this.states.set(strategyId, state);
    return state;
  }

  getPhase(strategyId: string): ScaleInState | undefined {
    return this.states.get(strategyId);
  }

  /** Check if phase should advance. Needs phaseSharpe > 0 and >= 7 days in current phase. */
  shouldAdvance(state: ScaleInState): boolean {
    if (state.phase >= 3) return false;
    const daysInPhase = (Date.now() - state.phaseStartDate) / 86_400_000;
    return daysInPhase >= MIN_PHASE_DAYS && state.phaseSharpe > 0;
  }

  advance(strategyId: string): ScaleInState | undefined {
    const state = this.states.get(strategyId);
    if (!state || state.phase >= 3) return undefined;
    if (!this.shouldAdvance(state)) return undefined;

    const nextPhase = (state.phase + 1) as 1 | 2 | 3;
    const newState: ScaleInState = {
      phase: nextPhase,
      phaseStartDate: Date.now(),
      capitalPct: PHASE_CAPITAL[nextPhase],
      phaseSharpe: 0,
    };
    this.states.set(strategyId, newState);
    return newState;
  }

  /** Returns capital multiplier: phase 1 = 0.25, phase 2 = 0.5, phase 3 = 1.0 */
  getCapitalMultiplier(strategyId: string): number {
    const state = this.states.get(strategyId);
    if (!state) return 1.0;
    return PHASE_CAPITAL[state.phase];
  }
}
