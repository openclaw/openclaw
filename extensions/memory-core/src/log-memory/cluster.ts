import { cosineSimilarity, vectorNorm } from "./store.js";
import type { LogMemoryEntry } from "./types.js";

const DEFAULT_THRESHOLD = 0.82;

export interface Cluster {
  centroid: Float32Array;
  members: LogMemoryEntry[];
}

// Greedy single-pass clustering: each entry attaches to the nearest existing
// centroid above the threshold, otherwise seeds a new cluster. Centroids are
// re-averaged on every join so the cluster drifts toward its members.
//
// Entries must already carry an `embedding`. Callers (the dream cycle) embed
// candidates before clustering so this module stays IO-free.
export function greedyClusterByCosine(
  entries: LogMemoryEntry[],
  opts?: { threshold?: number; minClusterSize?: number },
): Cluster[] {
  const threshold = opts?.threshold ?? DEFAULT_THRESHOLD;
  const minClusterSize = opts?.minClusterSize ?? 3;
  const clusters: Cluster[] = [];

  for (const entry of entries) {
    if (!entry.embedding || vectorNorm(entry.embedding) === 0) {
      continue;
    }
    let bestIndex = -1;
    let bestScore = threshold;
    for (let i = 0; i < clusters.length; i++) {
      const score = cosineSimilarity(entry.embedding, clusters[i].centroid);
      if (score >= bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    if (bestIndex >= 0) {
      const cluster = clusters[bestIndex];
      cluster.members.push(entry);
      cluster.centroid = recomputeCentroid(cluster.members);
    } else {
      clusters.push({
        centroid: cloneVector(entry.embedding),
        members: [entry],
      });
    }
  }
  return clusters.filter((c) => c.members.length >= minClusterSize);
}

function recomputeCentroid(members: LogMemoryEntry[]): Float32Array {
  const first = members[0]?.embedding;
  if (!first) {
    return new Float32Array(0);
  }
  const dims = first.length;
  const sum = new Float32Array(dims);
  let count = 0;
  for (const member of members) {
    if (!member.embedding || member.embedding.length !== dims) {
      continue;
    }
    for (let i = 0; i < dims; i++) {
      sum[i] += member.embedding[i];
    }
    count++;
  }
  if (count === 0) {
    return cloneVector(first);
  }
  for (let i = 0; i < dims; i++) {
    sum[i] /= count;
  }
  return sum;
}

function cloneVector(vec: Float32Array): Float32Array {
  return new Float32Array(vec);
}
