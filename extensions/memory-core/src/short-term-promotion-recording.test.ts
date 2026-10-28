// Memory Core tests cover short-term recall recording of Conversation Summary
// snippets: heading-inherited ordinary prose is kept, transcript wrappers are
// still rejected (issue #161268).
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it as baseIt, vi } from "vitest";
import * as recallStore from "./short-term-promotion-store.js";
import { buildClaimHash } from "./short-term-promotion-utils.js";
import { recordShortTermRecalls, type ShortTermRecallEntry } from "./short-term-promotion.js";
import { createMemoryCoreTestHarness, shortTermTestState as testing } from "./test-helpers.js";

vi.mock("openclaw/plugin-sdk/memory-host-events", () => ({
  appendMemoryHostEvent: vi.fn(async () => {}),
}));

type RecallResult = Parameters<typeof recordShortTermRecalls>[0]["results"][number];

function memoryRecallResult(
  memoryPath: string,
  startLine: number,
  endLine: number,
  score: number,
  snippet: string,
): RecallResult {
  return { path: memoryPath, startLine, endLine, score, snippet, source: "memory" };
}

async function recordMemoryRecalls(
  workspaceDir: string,
  query: string,
  results: RecallResult[],
): Promise<void> {
  await recordShortTermRecalls({ workspaceDir, query, results });
}

async function readRecallStoreSnippets(workspaceDir: string): Promise<string[]> {
  const store = await testing.readRecallStore(workspaceDir, new Date().toISOString());
  return Object.values(store.entries as Record<string, ShortTermRecallEntry>)
    .map((entry) => entry.snippet)
    .toSorted();
}

describe("short-term recall recording", () => {
  const { createTempWorkspace } = createMemoryCoreTestHarness();

  baseIt(
    "indexes retained claims once while daily signals keep the first matching entry",
    async () => {
      const workspaceDir = await createTempWorkspace("memory-promote-daily-index-");
      const nowIso = "2026-06-18T12:00:00.000Z";
      const snippet = "The archive uses compressed backups.";
      const retained = Array.from({ length: 512 }, (_, index): ShortTermRecallEntry => ({
        key: `memory:retained:${String(index).padStart(3, "0")}`,
        path: "memory/2026-06-18.md",
        startLine: index + 1,
        endLine: index + 1,
        source: "memory",
        snippet: index >= 510 ? snippet : `Stored observation ${index}.`,
        recallCount: 1,
        dailyCount: 0,
        groundedCount: 0,
        totalScore: 0.9,
        maxScore: 0.9,
        firstRecalledAt: nowIso,
        lastRecalledAt: nowIso,
        queryHashes: [],
        recallDays: [],
        conceptTags: [],
        claimHash: index >= 510 ? buildClaimHash(snippet) : `unrelated-${index}`,
      }));
      await testing.writeRawRecallStore(workspaceDir, {
        version: 1,
        updatedAt: nowIso,
        entries: Object.fromEntries(retained.map((entry) => [entry.key, entry])),
      });
      let claimHashReads = 0;
      using mocks = new DisposableStack();
      const readStore = recallStore.readStore;
      mocks.use(
        vi.spyOn(recallStore, "readStore").mockImplementation(async (...args) => {
          const store = await readStore(...args);
          for (const entry of Object.values(store.entries)) {
            const claimHash = entry.claimHash;
            Object.defineProperty(entry, "claimHash", {
              configurable: true,
              enumerable: true,
              get() {
                claimHashReads += 1;
                return claimHash;
              },
            });
          }
          return store;
        }),
      );
      const writeStore = recallStore.writeStore;
      mocks.use(
        vi.spyOn(recallStore, "writeStore").mockImplementation(async (dir, store) => {
          // Keep work-count instrumentation out of the storage serialization boundary.
          for (const entry of Object.values(store.entries)) {
            Object.defineProperty(entry, "claimHash", {
              configurable: true,
              enumerable: true,
              writable: true,
              value: entry.claimHash,
            });
          }
          await writeStore(dir, store);
        }),
      );
      await recordShortTermRecalls({
        workspaceDir,
        query: "daily archive notes",
        signalType: "daily",
        nowMs: Date.parse(nowIso),
        results: Array.from({ length: 32 }, () =>
          memoryRecallResult("memory/2026-06-19.md", 1, 1, 0.9, snippet),
        ),
      });
      const store = await testing.readRecallStore(workspaceDir, nowIso);
      expect(store.entries["memory:retained:510"]).toMatchObject({
        dailyCount: 32,
        recallCount: 1,
        path: "memory/2026-06-18.md",
        startLine: 511,
      });
      expect(store.entries["memory:retained:511"]?.dailyCount).toBe(0);
      expect(claimHashReads).toBeLessThanOrEqual(retained.length * 3);
    },
  );

  baseIt.each([
    ["Conversation Summary: Router VLAN 20 was migrated successfully.", true],
    ["- Conversation Summary: The on-call handoff covered the load balancer rotation.", true],
    ["Conversation Summary: The assistant recommended a verified backup.", true],
    ["Conversation Summary:", false],
    [
      "- Conversation Summary: user: Confirm the rollout finished before closing the ticket.",
      false,
    ],
    ["Conversation Summary: assistant: Traced all three. No changes made.", false],
    ["* conversation summary:\n- Assistant: Traced all three.", false],
    ["Conversation Summary: Session Key: agent:main:main", false],
    ["Conversation Summary: Session ID: fixture-session", false],
    ["Conversation Summary: - **Session Key**: agent:main:main", false],
    ["Conversation Summary: Session Key rotation was completed.", true],
  ])("records %s: %s", async (snippet, accepted) => {
    const workspaceDir = await createTempWorkspace("memory-promote-recording-");
    await fs.mkdir(path.join(workspaceDir, "memory", ".dreams"), { recursive: true });
    await recordMemoryRecalls(workspaceDir, "session recap", [
      memoryRecallResult("memory/2026-06-18.md", 1, 1, 0.92, snippet),
    ]);

    expect(await readRecallStoreSnippets(workspaceDir)).toEqual(accepted ? [snippet] : []);
  });
});
