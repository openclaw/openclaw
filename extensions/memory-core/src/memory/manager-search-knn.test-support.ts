import type { DatabaseSync } from "node:sqlite";
import {
  admitMemoryVectorIndex,
  searchMemoryVectorIndex,
  type VectorKnnRequest,
} from "./manager-search-knn.js";

export function runVectorKnnInSubprocess(params: {
  databasePath: string;
  request: VectorKnnRequest;
  extensionPath?: string;
  signal?: AbortSignal;
}) {
  return runVectorKnnQuery(params, params.request, params);
}

export function runVectorKnnQuery(
  store: DatabaseSync | { databasePath: string },
  request: VectorKnnRequest & { vectorTable?: string },
  options: { signal?: AbortSignal; extensionPath?: string } = {},
) {
  const search = admitMemoryVectorIndex(store, request.vectorTable);
  return searchMemoryVectorIndex(search.capability, search.index, request, options);
}

export const vectorToBlob = (embedding: number[]): Buffer =>
  Buffer.from(new Float32Array(embedding).buffer);
export function writeMemoryVectors(
  db: DatabaseSync,
  rows: readonly { id: string; embedding: number[] }[],
) {
  const search = admitMemoryVectorIndex(db);
  search.capability.write(search.index, rows);
}
