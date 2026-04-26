// Pinned hash of the canonical schema source. Updated together with
// `schema.ts` in the same PR. The companion file in MissionControl
// (`lib/orchestrator/schema.contract.ts`) carries the same constant; the
// MC-side test fails if the two repos drift.
//
// Pure value module. No runtime fs reads — the hash is recomputed from the
// schema source by the hash test only.

export const SCHEMA_HASH = "aa208ed5e08d7503b52062a0c388aaaea5eb40875edae856412372c1312ef51d";

/**
 * Strip TypeScript comments and collapse whitespace so cosmetic edits to
 * `schema.ts` don't break the hash. The same normaliser must run in both
 * repos; copy this function verbatim into MC's `lib/orchestrator/schema.contract.ts`.
 */
export function normalizeSchemaSource(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
