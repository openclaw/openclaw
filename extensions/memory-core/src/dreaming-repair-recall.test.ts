import fs from "node:fs/promises";
import path from "node:path";
import { openOpenClawStateDatabase } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { repairDreamingArtifacts } from "./dreaming-repair.js";
import {
  memoryCoreWorkspaceStateKey,
  SHORT_TERM_PHASE_SIGNAL_NAMESPACE,
} from "./dreaming-state.js";
import {
  auditShortTermPromotionArtifacts,
  repairShortTermPromotionArtifacts,
} from "./short-term-promotion-artifacts.js";
import {
  readShortTermRecallEntries,
  recordShortTermRecalls,
} from "./short-term-promotion-record.js";
import { recordDreamingPhaseSignals } from "./short-term-promotion-stats.js";
import { readPhaseSignalStore } from "./short-term-promotion-store.js";
import { createMemoryCoreTestHarness } from "./test-helpers.js";

const { createTempWorkspace } = createMemoryCoreTestHarness();
const nowIso = "2026-10-14T00:00:00.000Z";
const nowMs = Date.parse(nowIso);
const corpusPath = "memory/.dreams/session-corpus/2026-10-12.txt";
const livePaths = ["memory/2026-10-13.md", "memory/archive/2026-10-11.md"];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(nowMs);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function seedRecallSources() {
  const workspaceDir = await createTempWorkspace("archive-recall-");
  const results = [corpusPath, ...livePaths].map((sourcePath, index) => ({
    source: "memory" as const,
    path: sourcePath,
    startLine: 1,
    endLine: 1,
    score: 0.8,
    snippet: `Synthetic source ${index} keeps a separate durable memory.`,
  }));
  for (const result of results) {
    const absolutePath = path.join(workspaceDir, result.path);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, `${result.snippet}\n`);
  }
  await recordShortTermRecalls({
    workspaceDir,
    query: "synthetic archive sources",
    results,
    signalType: "grounded",
    nowMs,
    timezone: "America/Los_Angeles",
  });
  const recalls = await readShortTermRecallEntries({ workspaceDir, nowMs });
  await recordDreamingPhaseSignals({
    workspaceDir,
    phase: "light",
    keys: recalls.map((entry) => entry.key),
    nowMs,
  });
  const phases = (await readPhaseSignalStore(workspaceDir, nowIso)).entries;
  return { workspaceDir, recalls, phases };
}

it("prunes archived corpus recalls and phase signals while preserving existing sources", async () => {
  const { workspaceDir, recalls, phases } = await seedRecallSources();

  const repair = await repairDreamingArtifacts({ workspaceDir });

  expect(repair.archivedSessionCorpus).toBe(true);
  expect(repair.warnings).toEqual([]);
  const retained = await readShortTermRecallEntries({ workspaceDir, nowMs });
  expect(retained.map((entry) => entry.path).toSorted()).toEqual(livePaths.toSorted());
  const survivors = recalls.filter((entry) => entry.path !== corpusPath);
  expect(new Set(retained)).toEqual(new Set(survivors));
  expect((await readPhaseSignalStore(workspaceDir, nowIso)).entries).toEqual(
    Object.fromEntries(survivors.map((entry) => [entry.key, phases[entry.key]])),
  );
  await expect(auditShortTermPromotionArtifacts({ workspaceDir })).resolves.toMatchObject({
    danglingEntryCount: 0,
  });
  await expect(repairShortTermPromotionArtifacts({ workspaceDir })).resolves.toMatchObject({
    changed: false,
  });
});

it("preserves recall and phase signals when the archive rename fails", async () => {
  const { workspaceDir, recalls, phases } = await seedRecallSources();
  vi.spyOn(fs, "rename").mockRejectedValueOnce(
    Object.assign(new Error("synthetic archive rename denied"), { code: "EACCES" }),
  );

  const repair = await repairDreamingArtifacts({ workspaceDir });

  expect(repair.archivedSessionCorpus).toBe(false);
  expect(repair.warnings).toContain("synthetic archive rename denied");
  await expect(fs.stat(path.join(workspaceDir, corpusPath))).resolves.toBeDefined();
  expect(new Set(await readShortTermRecallEntries({ workspaceDir, nowMs }))).toEqual(
    new Set(recalls),
  );
  expect((await readPhaseSignalStore(workspaceDir, nowIso)).entries).toEqual(phases);
});

it("rolls back interrupted archive pruning and lets nightly repair finish", async () => {
  const { workspaceDir, recalls, phases } = await seedRecallSources();
  const db = openOpenClawStateDatabase().db;
  const workspaceKey = memoryCoreWorkspaceStateKey(workspaceDir);
  db.exec(`
    CREATE TRIGGER abort_archive_phase_delete BEFORE DELETE ON plugin_state_entries
    WHEN OLD.plugin_id = 'memory-core'
      AND OLD.namespace = '${SHORT_TERM_PHASE_SIGNAL_NAMESPACE}'
      AND json_extract(OLD.value_json, '$.workspaceKey') = '${workspaceKey}'
    BEGIN SELECT RAISE(ABORT, 'synthetic phase deletion failure'); END;
  `);
  try {
    const repair = await repairDreamingArtifacts({ workspaceDir });

    expect(repair.archivedSessionCorpus).toBe(true);
    expect(repair.warnings).toEqual([
      expect.stringContaining("Archive completed but recall cleanup failed"),
    ]);
    await expect(fs.stat(path.join(workspaceDir, corpusPath))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(new Set(await readShortTermRecallEntries({ workspaceDir, nowMs }))).toEqual(
      new Set(recalls),
    );
    expect((await readPhaseSignalStore(workspaceDir, nowIso)).entries).toEqual(phases);
  } finally {
    db.exec("DROP TRIGGER abort_archive_phase_delete");
  }

  await expect(repairShortTermPromotionArtifacts({ workspaceDir })).resolves.toMatchObject({
    changed: true,
    removedDanglingEntries: 1,
  });
  const survivors = recalls.filter((entry) => entry.path !== corpusPath);
  expect(new Set(await readShortTermRecallEntries({ workspaceDir, nowMs }))).toEqual(
    new Set(survivors),
  );
  expect((await readPhaseSignalStore(workspaceDir, nowIso)).entries).toEqual(
    Object.fromEntries(survivors.map((entry) => [entry.key, phases[entry.key]])),
  );
  await expect(auditShortTermPromotionArtifacts({ workspaceDir })).resolves.toMatchObject({
    danglingEntryCount: 0,
  });
});
