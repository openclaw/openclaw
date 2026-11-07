// Memory Core tests cover recall-store retention when nightly staging overflows.
import { describe, expect, it } from "vitest";
import { readStore } from "./short-term-promotion-store.js";
import { SHORT_TERM_RECALL_MAX_ENTRIES } from "./short-term-promotion-utils.js";
import { createMemoryCoreTestHarness, shortTermTestState as testing } from "./test-helpers.js";

const { createTempWorkspace } = createMemoryCoreTestHarness();
const STAGED_AT = "2026-10-02T03:00:00.000Z";
const RECALLED_AT = "2026-10-01T10:00:00.000Z";

function stagedEntry(key: string) {
  return {
    path: "memory/2026-10-02.md",
    startLine: 1,
    endLine: 1,
    source: "memory" as const,
    snippet: `Staged note ${key}.`,
    recallCount: 0,
    dailyCount: 1,
    groundedCount: 0,
    totalScore: 0.58,
    maxScore: 0.58,
    firstRecalledAt: STAGED_AT,
    lastRecalledAt: STAGED_AT,
    queryHashes: [],
    userQueryHashes: [],
    recallDays: [],
    conceptTags: [],
  };
}

function recalledEntry(key: string, overrides: Record<string, unknown> = {}) {
  return {
    path: "memory/2026-10-01.md",
    startLine: 1,
    endLine: 1,
    source: "memory" as const,
    snippet: `Recalled claim ${key}.`,
    recallCount: 5,
    dailyCount: 0,
    groundedCount: 0,
    totalScore: 4.55,
    maxScore: 0.91,
    firstRecalledAt: RECALLED_AT,
    lastRecalledAt: RECALLED_AT,
    queryHashes: [`q-${key}`],
    userQueryHashes: [`q-${key}`],
    recallDays: ["2026-10-01"],
    conceptTags: [],
    ...overrides,
  };
}

describe("short-term recall store retention", () => {
  it("does not let ineligible recalled rows starve fresh staging", async () => {
    const workspaceDir = await createTempWorkspace("recall-retention-ineligible-");
    const entries: Record<string, ReturnType<typeof recalledEntry>> = {};
    for (let index = 0; index < SHORT_TERM_RECALL_MAX_ENTRIES; index += 1) {
      entries[`promoted-${index}`] = recalledEntry(`promoted-${index}`, {
        promotedAt: "2026-10-01T12:00:00.000Z",
      });
    }
    // Query-hash-only evidence still earns a protected slot.
    entries["query-hash-only"] = recalledEntry("query-hash-only", {
      recallCount: 0,
      dailyCount: 1,
      queryHashes: [],
    });
    entries["staged-0"] = stagedEntry("staged-0");
    entries["staged-1"] = stagedEntry("staged-1");
    await testing.writeRawRecallStore(workspaceDir, { version: 1, updatedAt: STAGED_AT, entries });

    const store = await readStore(workspaceDir, STAGED_AT);
    const kept = Object.values(store.entries);

    expect(kept).toHaveLength(SHORT_TERM_RECALL_MAX_ENTRIES);
    expect(store.entries["staged-0"]).toBeDefined();
    expect(store.entries["staged-1"]).toBeDefined();
    expect(store.entries["query-hash-only"]).toBeDefined();
    expect(kept.filter((entry) => entry.promotedAt)).toHaveLength(
      SHORT_TERM_RECALL_MAX_ENTRIES - 3,
    );
  });
});
