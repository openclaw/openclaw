import fs from "node:fs/promises";
import path from "node:path";
import { openOpenClawStateDatabase } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { auditDreamingArtifacts, repairDreamingArtifacts } from "./dreaming-repair.js";
import {
  DREAMING_DAILY_INGESTION_NAMESPACE,
  DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
  DREAMING_SESSION_INGESTION_SEEN_NAMESPACE,
  memoryCoreWorkspaceStateKey,
  SHORT_TERM_PHASE_SIGNAL_NAMESPACE,
  readMemoryCoreWorkspaceEntries,
  writeMemoryCoreWorkspaceEntries,
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

const sessionNamespaces = [
  DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
  DREAMING_SESSION_INGESTION_SEEN_NAMESPACE,
];
const seedNamespace = (workspaceDir: string, namespace: string) =>
  writeMemoryCoreWorkspaceEntries({
    namespace,
    workspaceDir,
    entries: [{ key: "fixture", value: {} }],
  });

it("rejects relative workspace paths during audit and repair", async () => {
  for (const run of [auditDreamingArtifacts, repairDreamingArtifacts]) {
    await expect(run({ workspaceDir: "relative/workspace" })).rejects.toThrow(
      "workspaceDir must be an absolute path",
    );
  }
});

describe("archive recall cleanup", () => {
  const nowIso = "2026-10-14T00:00:00.000Z";
  const nowMs = Date.parse(nowIso);
  const corpusPath = "memory/.dreams/session-corpus/2026-10-12.txt";
  const livePaths = ["memory/2026-10-13.md", "memory/archive/2026-10-11.md"];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function seedRecallSources() {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(nowMs);
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
    const keys = recalls.map((entry) => entry.key);
    await recordDreamingPhaseSignals({ workspaceDir, phase: "light", keys, nowMs });
    const phases = (await readPhaseSignalStore(workspaceDir, nowIso)).entries;
    const survivors = recalls.filter((entry) => entry.path !== corpusPath);
    const before = { recalls: new Set(recalls), phases };
    const after = {
      recalls: new Set(survivors),
      phases: Object.fromEntries(survivors.map((entry) => [entry.key, phases[entry.key]])),
    };
    return {
      workspaceDir,
      expectState: async (archived: boolean) => {
        expect({
          recalls: new Set(await readShortTermRecallEntries({ workspaceDir, nowMs })),
          phases: (await readPhaseSignalStore(workspaceDir, nowIso)).entries,
        }).toEqual(archived ? after : before);
        if (archived) {
          await expect(auditShortTermPromotionArtifacts({ workspaceDir })).resolves.toMatchObject({
            danglingEntryCount: 0,
          });
        }
      },
    };
  }

  it("prunes archived corpus recalls and phase signals while preserving existing sources", async () => {
    const { workspaceDir, expectState } = await seedRecallSources();
    const expectIngestion = async (exists: boolean) => {
      expect((await auditDreamingArtifacts({ workspaceDir })).sessionIngestionExists).toBe(exists);
    };
    await seedNamespace(workspaceDir, DREAMING_DAILY_INGESTION_NAMESPACE);
    await expectIngestion(false);
    await Promise.all(sessionNamespaces.map((namespace) => seedNamespace(workspaceDir, namespace)));
    await expectIngestion(true);

    const repair = await repairDreamingArtifacts({ workspaceDir });

    expect(repair).toMatchObject({ archivedSessionCorpus: true, warnings: [] });
    for (const namespace of sessionNamespaces) {
      await expect(readMemoryCoreWorkspaceEntries({ namespace, workspaceDir })).resolves.toEqual(
        [],
      );
    }
    await expectIngestion(false);
    await expectState(true);
    await expect(repairShortTermPromotionArtifacts({ workspaceDir })).resolves.toMatchObject({
      changed: false,
    });
  });

  it("preserves recall and phase signals when the archive rename fails", async () => {
    const { workspaceDir, expectState } = await seedRecallSources();
    vi.spyOn(fs, "rename").mockRejectedValueOnce(
      Object.assign(new Error("synthetic archive rename denied"), { code: "EACCES" }),
    );

    const repair = await repairDreamingArtifacts({ workspaceDir });

    expect(repair.archivedSessionCorpus).toBe(false);
    expect(repair.warnings).toContain("synthetic archive rename denied");
    await expect(fs.stat(path.join(workspaceDir, corpusPath))).resolves.toBeDefined();
    await expectState(false);
  });

  it("rolls back interrupted archive pruning and lets nightly repair finish", async () => {
    const { workspaceDir, expectState } = await seedRecallSources();
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

      expect(repair).toMatchObject({
        archivedSessionCorpus: true,
        warnings: [expect.stringContaining("Archive completed but recall cleanup failed")],
      });
      await expect(fs.stat(path.join(workspaceDir, corpusPath))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expectState(false);
    } finally {
      db.exec("DROP TRIGGER abort_archive_phase_delete");
    }

    await expect(repairShortTermPromotionArtifacts({ workspaceDir })).resolves.toMatchObject({
      changed: true,
      removedDanglingEntries: 1,
    });
    await expectState(true);
  });
});
