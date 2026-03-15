import type { RetrievalCandidate, ScoredCandidate, SelfEvolveConfig } from "./types.js";

function zScore(values: number[]): number[] {
  if (values.length <= 1) {
    return values.map(() => 0);
  }
  const mean = values.reduce((acc, value) => acc + value, 0) / values.length;
  const variance = values.reduce((acc, value) => acc + (value - mean) ** 2, 0) / values.length;
  const std = Math.sqrt(variance);
  if (std <= 1e-12) {
    return values.map(() => 0);
  }
  return values.map((value) => (value - mean) / std);
}

export function scoreCandidates(
  candidates: RetrievalCandidate[],
  config: SelfEvolveConfig,
): ScoredCandidate[] {
  const similarityZ = zScore(candidates.map((candidate) => candidate.similarity));
  const qZ = zScore(candidates.map((candidate) => candidate.triplet.qValue));
  return candidates
    .map((candidate, index) => {
      const score =
        (1 - config.retrieval.lambda) * similarityZ[index] + config.retrieval.lambda * qZ[index];
      return {
        ...candidate,
        similarityZ: similarityZ[index],
        qValueZ: qZ[index],
        score,
      };
    })
    .toSorted((left, right) => right.score - left.score);
}

function sampleWithoutReplacement<T>(items: T[], limit: number, random: () => number): T[] {
  const list = [...items];
  for (let index = list.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [list[index], list[swapIndex]] = [list[swapIndex], list[index]];
  }
  return list.slice(0, limit);
}

export function selectPhaseB(params: {
  candidates: RetrievalCandidate[];
  config: SelfEvolveConfig;
  random?: () => number;
}): {
  selected: ScoredCandidate[];
  scored: ScoredCandidate[];
  simMax: number;
} {
  if (params.candidates.length === 0) {
    return { selected: [], scored: [], simMax: 0 };
  }
  const simMax = Math.max(...params.candidates.map((candidate) => candidate.similarity));
  if (simMax < params.config.retrieval.tau) {
    return {
      selected: [],
      scored: scoreCandidates(params.candidates, params.config),
      simMax,
    };
  }

  const scored = scoreCandidates(params.candidates, params.config);
  const limit = Math.min(params.config.retrieval.k2, scored.length);
  const random = params.random ?? Math.random;
  if (random() < params.config.retrieval.epsilon) {
    return {
      selected: sampleWithoutReplacement(scored, limit, random),
      scored,
      simMax,
    };
  }
  return {
    selected: scored.slice(0, limit),
    scored,
    simMax,
  };
}
