import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { defaultRuntime } from "./cli.host.runtime.js";
import { registerMemoryCli } from "./cli.js";
import { rehydratePromotionCandidate } from "./short-term-promotion-rehydrate.js";
import {
  rankShortTermPromotionCandidates,
  readShortTermRecallEntries,
} from "./short-term-promotion.js";
import { createMemoryCoreTestHarness } from "./test-helpers.js";

const getMemorySearchManager = vi.hoisted(() => vi.fn());

vi.mock("./cli.host.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cli.host.runtime.js")>()),
  getMemorySearchManager,
  getRuntimeConfig: () => ({}),
  resolveDefaultAgentId: () => "main",
  resolveCommandSecretRefsViaGateway: async ({ config }: { config: unknown }) => ({
    resolvedConfig: config,
    diagnostics: [],
  }),
}));

const { createTempWorkspace } = createMemoryCoreTestHarness();

afterEach(() => {
  getMemorySearchManager.mockReset();
  vi.restoreAllMocks();
});

async function stageGroundedMemory(sourcePath: string) {
  const program = new Command();
  registerMemoryCli(program);
  await program.parseAsync(
    ["memory", "rem-backfill", "--path", sourcePath, "--stage-short-term", "--json"],
    { from: "user" },
  );
}

it.each([
  { heading: "Preferences Learned", timezone: "Always use UTC." },
  { heading: "Notes", timezone: "Prefer UTC: yes" },
])(
  "stages $heading summaries as independently rehydratable source snippets",
  async ({ heading, timezone }) => {
    const workspaceDir = await createTempWorkspace("rem-grounding-");
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir);
    const relativePath = "memory/2025-01-01.md";
    const sourcePath = path.join(workspaceDir, relativePath);
    const drink = "Prefer tea.";
    await fs.writeFile(
      sourcePath,
      [`## ${heading}`, `- ${timezone}`, "", `- ${drink}`, ""].join("\n"),
    );
    const close = vi.fn(async () => {});
    getMemorySearchManager.mockResolvedValue({
      manager: { status: () => ({ workspaceDir }), close },
    });
    const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});

    for (let run = 0; run < 2; run += 1) {
      await stageGroundedMemory(sourcePath);
      const entries = await readShortTermRecallEntries({ workspaceDir });
      expect(entries).toHaveLength(2);
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: relativePath,
            startLine: 2,
            endLine: 2,
            snippet: timezone,
            groundedCount: 2,
            recallCount: 0,
            recallDays: ["2025-01-01"],
          }),
          expect.objectContaining({
            path: relativePath,
            startLine: 4,
            endLine: 4,
            snippet: drink,
            groundedCount: 2,
            recallCount: 0,
            recallDays: ["2025-01-01"],
          }),
        ]),
      );
      expect(entries.every((entry) => entry.queryHashes.length === 1)).toBe(true);
      expect(writeJson).toHaveBeenLastCalledWith(
        expect.objectContaining({ stagedShortTermEntries: 2, replacedShortTermEntries: run * 2 }),
      );
    }
    expect(close).toHaveBeenCalledTimes(2);

    const candidates = await rankShortTermPromotionCandidates({
      workspaceDir,
      minScore: 0,
      minRecallCount: 0,
      minUniqueQueries: 0,
    });
    expect(candidates).toHaveLength(2);
    for (const candidate of candidates) {
      expect(await rehydratePromotionCandidate(workspaceDir, candidate)).toMatchObject({
        path: candidate.path,
        startLine: candidate.startLine,
        endLine: candidate.endLine,
        snippet: candidate.snippet,
      });
    }
    await fs.writeFile(sourcePath, `## ${heading}\n- ${timezone}\n`);
    const drinkCandidate = candidates.find((candidate) => candidate.snippet === drink);
    expect(drinkCandidate).toBeDefined();
    if (drinkCandidate) {
      expect(await rehydratePromotionCandidate(workspaceDir, drinkCandidate)).toBeNull();
    }
  },
);

it("retains every coalesced atomic claim without restaging transient source text", async () => {
  const workspaceDir = await createTempWorkspace("rem-atomic-grounding-");
  const memoryDir = path.join(workspaceDir, "memory");
  await fs.mkdir(memoryDir);
  const sourcePath = path.join(memoryDir, "2025-01-02.md");
  await fs.writeFile(
    sourcePath,
    [
      "## People Update",
      "- Alex is my partner. We met today at the hotel.",
      "",
      "## People Update",
      "- Alex is my partner. Dinner is booked for tomorrow.",
      "",
    ].join("\n"),
  );
  getMemorySearchManager.mockResolvedValue({ manager: { status: () => ({ workspaceDir }) } });
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});

  await stageGroundedMemory(sourcePath);

  const entries = await readShortTermRecallEntries({ workspaceDir });
  expect(entries).toHaveLength(2);
  expect(entries.map((entry) => entry.startLine).toSorted((a, b) => a - b)).toEqual([2, 5]);
  for (const entry of entries) {
    expect(entry).toMatchObject({
      path: "memory/2025-01-02.md",
      endLine: entry.startLine,
      snippet: "People Update: Alex is my partner.",
      groundedCount: 3,
    });
  }
});
