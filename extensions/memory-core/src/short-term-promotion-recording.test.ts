// Memory Core tests cover short-term recall recording of Conversation Summary
// snippets: heading-inherited ordinary prose is kept, transcript wrappers are
// still rejected (issue #161268).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendMemoryHostEvent } from "openclaw/plugin-sdk/memory-host-events";
import { afterAll, beforeAll, describe, expect, it as baseIt, vi } from "vitest";
import { recordMemoryRecall } from "./interactive-recall.js";
import { recordShortTermRecalls, type ShortTermRecallEntry } from "./short-term-promotion.js";
import {
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
  shortTermTestState as testing,
} from "./test-helpers.js";

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

describe("short-term recall recording of Conversation Summary snippets", () => {
  let fixtureRoot = "";
  let caseId = 0;

  beforeAll(async () => {
    await configureMemoryCoreDreamingStateForTests();
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-promote-recording-"));
  });

  afterAll(async () => {
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
    resetMemoryCoreDreamingStateForTests();
  });

  baseIt(
    "preserves native query diversity and conservative provenance through public recall admission",
    async () => {
      const workspaceDir = path.join(fixtureRoot, `api-case-${caseId++}`);
      await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
      const snippet = "Verify the backup before changing the rollout.";
      const result = memoryRecallResult("memory/2026-01-02.md", 1, 1, 0.9, snippet);
      await fs.writeFile(path.join(workspaceDir, result.path), `${snippet}\n`);
      const params = {
        config: {
          plugins: { entries: { "memory-core": { config: { dreaming: { enabled: true } } } } },
        },
        workspaceDir,
        query: "rollout backup",
        results: [result],
        sessionKey: "agent:fixture:main",
        runId: "synthetic-first-run",
        assertActive: () => {},
      };
      const claim = () => true;
      await recordMemoryRecall(params, claim);
      await recordMemoryRecall(
        { ...params, runId: "synthetic-next-run", query: "deployment recovery" },
        claim,
      );
      let store = await testing.readRecallStore(workspaceDir, new Date().toISOString());
      let entry = Object.values(store.entries as Record<string, ShortTermRecallEntry>)[0]!;
      expect(entry.recallCount).toBe(2);
      expect(entry.userQueryHashes).toHaveLength(2);
      expect(entry.provenance).toMatchObject({ originClass: "agent", sessionKind: "unknown" });
      await recordMemoryRecall(
        {
          ...params,
          results: [
            {
              ...result,
              provenance: {
                originClass: "untrusted",
                sessionKind: "unknown",
                observedAt: 1,
              },
            },
          ],
        },
        claim,
      );
      store = await testing.readRecallStore(workspaceDir, new Date().toISOString());
      entry = Object.values(store.entries as Record<string, ShortTermRecallEntry>)[0]!;
      expect(entry.provenance?.originClass).toBe("untrusted");
      await expect(
        recordShortTermRecalls({
          workspaceDir,
          query: "late query",
          results: [result],
          assertCurrent: () => {
            throw new Error("closed");
          },
        }),
      ).rejects.toThrow("closed");
      store = await testing.readRecallStore(workspaceDir, new Date().toISOString());
      expect(
        Object.values(store.entries as Record<string, ShortTermRecallEntry>)[0]!.recallCount,
      ).toBe(3);
    },
  );

  baseIt.each(["same-batch", "cross-call", "concurrent", "prior-full"] as const)(
    "merges lower-trust clipped/full duplicate observations without new signals: %s",
    async (mode) => {
      const workspaceDir = path.join(fixtureRoot, `provenance-case-${caseId++}`);
      await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
      const snippet = "Verify the synthetic rollout backup.";
      const first = memoryRecallResult("memory/2026-01-02.md", 1, 1, 0.9, snippet);
      const duplicate = {
        ...first,
        endLine: 2,
        snippet: `${snippet}\nKeep the original snapshot.`,
        score: 0.99,
        provenance: {
          originClass: "untrusted" as const,
          sessionKind: "unknown" as const,
          observedAt: 1,
        },
      };
      await fs.writeFile(path.join(workspaceDir, first.path), `${duplicate.snippet}\n`);
      const seen = new Set<string>();
      const claim = (result: typeof first) => {
        const key = `${result.path}:${result.startLine}`;
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      };
      const params = {
        config: {
          plugins: { entries: { "memory-core": { config: { dreaming: { enabled: true } } } } },
        },
        workspaceDir,
        query: "first actual query",
        results: [first],
        sessionKey: "agent:fixture:main",
        runId: "synthetic-provenance-run",
        assertActive: () => {},
      };
      if (mode === "prior-full") {
        const { provenance: _provenance, ...priorFull } = duplicate;
        await recordMemoryRecall(
          { ...params, runId: "prior-run", results: [priorFull] },
          () => true,
        );
      }
      vi.mocked(appendMemoryHostEvent).mockClear();
      if (mode === "same-batch") {
        await recordMemoryRecall({ ...params, results: [first, duplicate] }, claim);
      } else if (mode === "concurrent") {
        await Promise.all([
          recordMemoryRecall(params, claim),
          recordMemoryRecall(
            { ...params, query: "different duplicate query", results: [duplicate] },
            claim,
          ),
        ]);
      } else {
        await recordMemoryRecall(params, claim);
        await recordMemoryRecall(
          { ...params, query: "different duplicate query", results: [duplicate] },
          claim,
        );
      }
      const store = await testing.readRecallStore(workspaceDir, new Date().toISOString());
      const entries = Object.values(store.entries as Record<string, ShortTermRecallEntry>);
      expect(entries).toHaveLength(mode === "prior-full" ? 2 : 1);
      expect(entries.every((entry) => entry.provenance?.originClass === "untrusted")).toBe(true);
      expect(entries.every((entry) => entry.recallCount === 1)).toBe(true);
      expect(entries[0]!.recallCount).toBe(1);
      expect(entries[0]!.userQueryHashes).toHaveLength(1);
      expect(entries[0]!.provenance?.originClass).toBe("untrusted");
      if (mode !== "concurrent" && mode !== "prior-full") {
        expect(entries[0]!.maxScore).toBe(0.9);
        expect(entries[0]!.totalScore).toBe(0.9);
        expect(entries[0]!.lastRecalledAt).toBe(entries[0]!.firstRecalledAt);
      }
      expect(
        vi
          .mocked(appendMemoryHostEvent)
          .mock.calls.filter(([, event]) => event.type === "memory.recall.recorded"),
      ).toHaveLength(1);
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
    const workspaceDir = path.join(fixtureRoot, `case-${caseId++}`);
    await fs.mkdir(path.join(workspaceDir, "memory", ".dreams"), { recursive: true });
    await recordMemoryRecalls(workspaceDir, "session recap", [
      memoryRecallResult("memory/2026-06-18.md", 1, 1, 0.92, snippet),
    ]);

    expect(await readRecallStoreSnippets(workspaceDir)).toEqual(accepted ? [snippet] : []);
  });
});
