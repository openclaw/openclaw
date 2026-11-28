// Memory Core tests cover recall-store retention when nightly staging overflows.
import { describe, expect, it } from "vitest";
import { readStore } from "./short-term-promotion-store.js";
import {
  MAX_PROTECTED_RECALL_ENTRIES,
  SHORT_TERM_RECALL_MAX_ENTRIES,
} from "./short-term-promotion-utils.js";
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
    snippet: "Staged note " + key + ".",
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

// A row that carries interactive recall evidence: the durable signal the
// retention policy protects. One recall is enough - the promotion ranker's own
// count thresholds are promotion-time criteria, not retention criteria.
function recalledEntry(key: string, overrides: Record<string, unknown> = {}) {
  const queryHashes = ["q-" + key + "-1", "q-" + key + "-2", "q-" + key + "-3"];
  return {
    path: "memory/2026-10-01.md",
    startLine: 1,
    endLine: 1,
    source: "memory" as const,
    snippet: "Recalled claim " + key + ".",
    recallCount: 3,
    dailyCount: 0,
    groundedCount: 0,
    totalScore: 3,
    maxScore: 0.91,
    firstRecalledAt: RECALLED_AT,
    lastRecalledAt: RECALLED_AT,
    queryHashes,
    userQueryHashes: queryHashes,
    recallDays: ["2026-10-01"],
    conceptTags: [],
    ...overrides,
  };
}

function singleRecallEntry(key: string) {
  return {
    path: "memory/2026-10-01.md",
    startLine: 1,
    endLine: 1,
    source: "memory" as const,
    snippet: "Once recalled claim " + key + ".",
    recallCount: 1,
    dailyCount: 0,
    groundedCount: 0,
    totalScore: 1,
    maxScore: 0.91,
    firstRecalledAt: RECALLED_AT,
    lastRecalledAt: RECALLED_AT,
    queryHashes: ["q-" + key],
    userQueryHashes: ["q-" + key],
    recallDays: ["2026-10-01"],
    conceptTags: [],
  };
}

describe("short-term recall store retention", () => {
  it("keeps a row with one interactive recall ahead of fresh staging", async () => {
    const workspaceDir = await createTempWorkspace("recall-retention-single-recall-");
    const entries: Record<string, ReturnType<typeof recalledEntry>> = {};
    for (let index = 0; index < SHORT_TERM_RECALL_MAX_ENTRIES; index += 1) {
      entries["promoted-" + index] = recalledEntry("promoted-" + index, {
        promotedAt: "2026-10-01T12:00:00.000Z",
      });
    }
    // One interactive recall is the weakest evidence the promotion path can
    // still use, and it is the shape upstream fleets report (max recall count
    // 2 on openclaw/openclaw#150635).
    entries["single-recall"] = singleRecallEntry("single-recall");
    entries["staged-0"] = stagedEntry("staged-0");
    entries["staged-1"] = stagedEntry("staged-1");
    await testing.writeRawRecallStore(workspaceDir, { version: 1, updatedAt: STAGED_AT, entries });

    const store = await readStore(workspaceDir, STAGED_AT);
    const kept = Object.values(store.entries);

    expect(kept).toHaveLength(SHORT_TERM_RECALL_MAX_ENTRIES);
    expect(store.entries["single-recall"]).toBeDefined();
    expect(store.entries["staged-0"]).toBeDefined();
    expect(store.entries["staged-1"]).toBeDefined();
    // The already-promoted rows carry no value for the promotion path, so they
    // are the ones that lose their slot.
    expect(kept.filter((entry) => entry.promotedAt)).toHaveLength(
      SHORT_TERM_RECALL_MAX_ENTRIES - 3,
    );
  });

  it("keeps a row that clears the ranker's recall and query thresholds", async () => {
    const workspaceDir = await createTempWorkspace("recall-retention-protected-");
    const entries: Record<string, ReturnType<typeof recalledEntry>> = {};
    for (let index = 0; index < SHORT_TERM_RECALL_MAX_ENTRIES; index += 1) {
      entries["staged-" + index] = stagedEntry("staged-" + index);
    }
    entries["promotable"] = recalledEntry("promotable");
    await testing.writeRawRecallStore(workspaceDir, { version: 1, updatedAt: STAGED_AT, entries });

    const store = await readStore(workspaceDir, STAGED_AT);
    expect(Object.values(store.entries)).toHaveLength(SHORT_TERM_RECALL_MAX_ENTRIES);
    expect(store.entries["promotable"]).toBeDefined();
  });

  it("bounds the protected set so staging rows keep entering the window", async () => {
    const workspaceDir = await createTempWorkspace("recall-retention-cap-");
    const entries: Record<string, ReturnType<typeof recalledEntry>> = {};
    for (let index = 0; index < 200; index += 1) {
      entries["promotable-" + index] = recalledEntry("promotable-" + index);
    }
    for (let index = 0; index < 400; index += 1) {
      entries["staged-" + index] = stagedEntry("staged-" + index);
    }
    await testing.writeRawRecallStore(workspaceDir, { version: 1, updatedAt: STAGED_AT, entries });

    const store = await readStore(workspaceDir, STAGED_AT);
    const kept = Object.values(store.entries);
    expect(kept).toHaveLength(SHORT_TERM_RECALL_MAX_ENTRIES);
    // The protected set stays bounded, and the rest of the window keeps
    // turning over for fresh staging rows.
    expect(kept.filter((entry) => (entry.userQueryHashes?.length ?? 0) >= 3)).toHaveLength(
      MAX_PROTECTED_RECALL_ENTRIES,
    );
    expect(kept.filter((entry) => entry.dailyCount > 0)).toHaveLength(
      SHORT_TERM_RECALL_MAX_ENTRIES - MAX_PROTECTED_RECALL_ENTRIES,
    );
  });

  it("spends the bounded protected slots on the strongest recall evidence", async () => {
    const workspaceDir = await createTempWorkspace("recall-retention-strength-");
    const entries: Record<string, ReturnType<typeof recalledEntry>> = {};
    for (let index = 0; index < 383; index += 1) {
      entries["staged-" + index] = stagedEntry("staged-" + index);
    }
    // 129 evidence rows for 128 protected slots. The strongest row is also the
    // least recently recalled, so recency ordering alone would evict it.
    for (let index = 0; index < 128; index += 1) {
      entries["weak-" + index] = recalledEntry("weak-" + index, {
        recallCount: 1,
        queryHashes: ["q-weak-" + index],
        userQueryHashes: ["q-weak-" + index],
        lastRecalledAt: "2026-10-01T23:00:00.000Z",
      });
    }
    entries["strong"] = recalledEntry("strong", {
      recallCount: 5,
      // Older than the weak rows but still inside the 30-day age window, so
      // only the evidence ordering can protect it.
      lastRecalledAt: "2026-09-20T10:00:00.000Z",
    });
    entries["staged-overflow"] = stagedEntry("staged-overflow");
    await testing.writeRawRecallStore(workspaceDir, { version: 1, updatedAt: STAGED_AT, entries });

    const store = await readStore(workspaceDir, STAGED_AT);
    const kept = Object.values(store.entries);
    expect(kept).toHaveLength(SHORT_TERM_RECALL_MAX_ENTRIES);
    // The strongest evidence keeps its slot even though it was recalled least
    // recently, and exactly the bounded protected set survives.
    expect(store.entries["strong"]).toBeDefined();
    expect(kept.filter((entry) => (entry.userQueryHashes?.length ?? 0) > 0)).toHaveLength(
      MAX_PROTECTED_RECALL_ENTRIES,
    );
    expect(kept.filter((entry) => entry.dailyCount > 0)).toHaveLength(
      SHORT_TERM_RECALL_MAX_ENTRIES - MAX_PROTECTED_RECALL_ENTRIES,
    );
  });
});
