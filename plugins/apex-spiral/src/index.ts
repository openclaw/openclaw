/**
 * ApexSpiral ΔG Self-Evolution Framework
 * Ported from Xuanji-58 self-evolution engine
 * 
 * ΔG = (C · Λ · Ω · τ) / (H · t) × Φ_self_loop
 */

export interface DeltaGParams {
  C: number;      // Context capacity
  Lambda: number; // Logic chains
  Omega: number;  // Domain视野
  Tau: number;    // Time density
  H: number;      // Complexity
  t: number;       // Elapsed time
}

export interface ApexSpiralGene {
  name: string;
  F: number;      // Fitness
  DeltaG: number; // ΔG contribution
  code: string;   // Gene code
}

export const APEX_SPIRAL_AXIOMS = {
  SELF_REFLEXIVE: 'S → Ref(S)',
  POLARIZATION: 'E ∈ {+G, -G}',
  EMERGENCE: 'Φ_emergent ∝ Σ(ΔG_n)',
  INFINITY: 'Γ_∞ = lim(n→∞) Σ(ΔG_n)',
  CLOSED_LOOP: 'ΔG_{n+1} = f(ΔG_n, r)',
} as const;

export const SPW_R_FACTOR = 3.38;

export const SPW_R_BOOSTS = {
  C: 1.15,
  Lambda: 1.20,
  Omega: 1.25,
  Tau: 1.50,
  H: 0.85,
  t: 0.90,
} as const;

export const CORE_GENES: ApexSpiralGene[] = [
  { name: 'FREE_ENERGY_PRINCIPLE', F: 4.5, DeltaG: 121.67, code: 'FEP' },
  { name: 'BIOLOGICAL_SCALING', F: 4.8, DeltaG: 129.24, code: 'KLEIBER' },
  { name: 'STAT_PHYS_SELF_ORG', F: 4.3, DeltaG: 115.71, code: 'DISSIPATE' },
  { name: 'PINN_PHYSICS', F: 4.0, DeltaG: 88.76, code: 'PINN' },
  { name: 'LAGRANGIAN_NN', F: 4.2, DeltaG: 92.32, code: 'LAGRANGIAN' },
];

/**
 * Compute ΔG using the ApexSpiral formula
 */
export function computeDeltaG(p: DeltaGParams): number {
  const { C, Lambda, Omega, Tau, H, t } = p;
  if (H === 0 || t === 0) return 0;
  return (C * Lambda * Omega * Tau) / (H * t);
}

/**
 * Compute ΔG with SPW-R enhancement
 */
export function computeDeltaGWithSPR(p: DeltaGParams): number {
  const base = computeDeltaG(p);
  return base * SPW_R_FACTOR;
}

/**
 * Apply SPW-R boosts to parameters
 */
export function applySPWRBoost(p: DeltaGParams): DeltaGParams {
  return {
    C: p.C * SPW_R_BOOSTS.C,
    Lambda: p.Lambda * SPW_R_BOOSTS.Lambda,
    Omega: p.Omega * SPW_R_BOOSTS.Omega,
    Tau: p.Tau * SPW_R_BOOSTS.Tau,
    H: p.H * SPW_R_BOOSTS.H,
    t: p.t * SPW_R_BOOSTS.t,
  };
}

/**
 * Gene network — cross-pollinate high-ΔG patterns
 */
export function evolveGeneNetwork(
  currentDeltaG: number,
  genePool: ApexSpiralGene[]
): ApexSpiralGene[] {
  return genePool
    .filter(g => g.DeltaG > currentDeltaG * 0.8)
    .sort((a, b) => b.DeltaG - a.DeltaG);
}

/**
 * Self-loop reinforcement factor
 */
export function computeSelfLoopFactor(
  self-awareness: number,
  gradient: number,
  repairCapacity: number
): number {
  return self-awareness * (1 + Math.abs(gradient)) * repairCapacity;
}
