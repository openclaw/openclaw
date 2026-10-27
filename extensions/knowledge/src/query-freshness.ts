import { Type } from "typebox";
import { text } from "./model.js";

export const QueryFreshness = Type.Object(
  {
    queriedAt: text(40),
    scannedAt: text(40),
    indexedAt: Type.Optional(text(40)),
  },
  { additionalProperties: false },
);

/** Distinguish query execution from reusable scan and index observations. */
export function queryFreshness(scannedAt: string, indexedAt?: string) {
  return { queriedAt: new Date().toISOString(), scannedAt, ...(indexedAt ? { indexedAt } : {}) };
}
