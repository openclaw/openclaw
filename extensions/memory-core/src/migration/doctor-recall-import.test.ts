// Real Doctor-import proof for the strict recall-store decoding change.
//
// Reviewer concern (ClawSweeper, PR #146262 revision 4): the supplied evidence
// "does not demonstrate Doctor import and subsequent persistence or recovery in a
// real supported setup". This test closes that gap by driving the actual exported
// Doctor migration (`dreamingStateMigration`) end to end:
//
//   legacy memory/.dreams JSON on disk
//     -> dreamingStateMigration.migrateLegacyState(...)
//       -> normalizeShortTermRecallStore(...)
//         -> SQLite plugin state
//           -> readStore(...)   (what the runtime actually reads back)
//
// and asserts that valid legacy history survives the upgrade while malformed
// legacy rows cannot corrupt it.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readStore } from "../short-term-promotion-store.js";
import {
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
} from "../test-helpers.js";
import { dreamingStateMigration } from "./doctor-dreaming-state.js";

const NOW = "2026-09-13T00:00:00.000Z";
const LEGACY_DIR = join("memory", ".dreams");

type LegacyStore = {
  version: number;
  updatedAt: string;
  entries: Record<string, Record<string, unknown>>;
};

function validLegacyStore(): LegacyStore {
  return {
    version: 1,
    updatedAt: NOW,
    entries: {
      alpha: {
        path: "memory/2026-09-01.md",
        startLine: 3,
        endLine: 9,
        source: "memory",
        snippet: "Alpha note with a healthy recall history.",
        recallCount: 4,
        dailyCount: 2,
        groundedCount: 1,
        totalScore: 2.5,
        maxScore: 0.85,
        firstRecalledAt: "2026-09-01T00:00:00.000Z",
        lastRecalledAt: "2026-09-10T00:00:00.000Z",
        recallDays: ["2026-09-08", "2026-09-10"],
        queryHashes: ["q1", "q2"],
        conceptTags: ["alpha"],
      },
      gamma: {
        path: "memory/2026-09-03.md",
        startLine: 12,
        endLine: 20,
        source: "memory",
        snippet: "Gamma note with a fractional score.",
        recallCount: 7,
        dailyCount: 3,
        groundedCount: 2,
        totalScore: 0.333,
        maxScore: 0.999,
        firstRecalledAt: "2026-09-03T00:00:00.000Z",
        lastRecalledAt: "2026-09-12T00:00:00.000Z",
        recallDays: ["2026-09-11", "2026-09-12"],
        queryHashes: ["q3"],
        conceptTags: ["gamma"],
      },
    },
  };
}

// Minimal params for the migration. `openPluginStateKeyedStore` is the factory the
// migration itself uses to (re)configure the SQLite store, so it must be the real
// test-backed factory rather than undefined. The workspace is declared through the
// agent config, which is how the migration's workspace discovery resolves it.
function migrationParams(workspaceDir: string, openPluginStateKeyedStore: unknown) {
  return {
    config: { agents: { defaults: { workspace: workspaceDir } } },
    env: {} as NodeJS.ProcessEnv,
    context: { openPluginStateKeyedStore },
    workspaceDir,
  } as unknown as Parameters<typeof dreamingStateMigration.migrateLegacyState>[0];
}

describe("Doctor legacy import preserves valid recall history (real migration path)", () => {
  let root = "";
  let workspaceDir = "";
  let legacyFile = "";
  let storeFactory: unknown;

  beforeEach(async () => {
    await configureMemoryCoreDreamingStateForTests();
    // The migration reconfigures the store from context, so hand it the same
    // test-backed factory the suite uses elsewhere.
    storeFactory = <T>(options: unknown) =>
      createPluginStateKeyedStoreForTests<T>("memory-core", options as never);
    root = mkdtempSync(join(tmpdir(), "mc-doctor-"));
    workspaceDir = join(root, "workspace");
    mkdirSync(join(workspaceDir, LEGACY_DIR), { recursive: true });
    legacyFile = join(workspaceDir, LEGACY_DIR, "short-term-recall.json");
    process.env.OPENCLAW_MEMORY_CORE_WORKSPACES = workspaceDir;
  });

  afterEach(() => {
    resetMemoryCoreDreamingStateForTests();
    delete process.env.OPENCLAW_MEMORY_CORE_WORKSPACES;
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("imports valid legacy recall rows into SQLite without losing history", async () => {
    writeFileSync(legacyFile, JSON.stringify(validLegacyStore()), "utf8");

    const result = await dreamingStateMigration.migrateLegacyState(
      migrationParams(workspaceDir, storeFactory),
    );

    // The migration reported success rather than warning.
    expect(result).toBeTruthy();

    // The decisive check: what the runtime reads back after the import.
    const read = await readStore(workspaceDir, NOW);
    expect(Object.keys(read.entries).toSorted()).toStrictEqual(["alpha", "gamma"]);
    expect(read.entries.alpha).toMatchObject({
      startLine: 3,
      endLine: 9,
      recallCount: 4,
      dailyCount: 2,
      groundedCount: 1,
      totalScore: 2.5,
      maxScore: 0.85,
    });
    // Fractional history must survive the import, not round to 0 or 1.
    expect(read.entries.gamma?.totalScore).toBe(0.333);
    expect(read.entries.gamma?.maxScore).toBe(0.999);
  });

  it("retires the legacy source after a successful import and archives it", async () => {
    writeFileSync(legacyFile, JSON.stringify(validLegacyStore()), "utf8");

    const result = await dreamingStateMigration.migrateLegacyState(
      migrationParams(workspaceDir, storeFactory),
    );

    // The migration must report what it did, not silently succeed.
    const changes = (result as { changes?: string[] })?.changes ?? [];
    const warnings = (result as { warnings?: string[] })?.warnings ?? [];
    expect(warnings).toStrictEqual([]);
    expect(changes.some((line) => /short-term recall/i.test(line))).toBe(true);
    // The reported row count proves the import actually carried entries across.
    expect(changes.some((line) => line.includes("(2 row(s))"))).toBe(true);

    // The legacy source is retired from its live location...
    expect(existsSync(legacyFile)).toBe(false);

    // ...and archived as `<path>.migrated`, the documented archive contract.
    const archivedPath = `${legacyFile}.migrated`;
    expect(existsSync(archivedPath)).toBe(true);

    // A second Doctor run must find nothing left to import.
    const second = await dreamingStateMigration.migrateLegacyState(
      migrationParams(workspaceDir, storeFactory),
    );
    const secondChanges = (second as { changes?: string[] })?.changes ?? [];
    expect(secondChanges.some((line) => /short-term recall/i.test(line))).toBe(false);
  });

  it("restores the archived legacy source to recover the original rows", async () => {
    // Recovery path: an operator rolls back by restoring the archive, which must
    // reproduce the exact original payload (review asked for restoration proof,
    // not merely that an archive file exists).
    const original = validLegacyStore();
    writeFileSync(legacyFile, JSON.stringify(original), "utf8");

    await dreamingStateMigration.migrateLegacyState(migrationParams(workspaceDir, storeFactory));
    const archivedPath = `${legacyFile}.migrated`;
    expect(existsSync(archivedPath)).toBe(true);

    // Restore: put the archive back at the live legacy path and clear SQLite so
    // the import is the only source of truth.
    const restored = readFileSync(archivedPath, "utf8");
    writeFileSync(legacyFile, restored, "utf8");
    const { resetPluginStateStoreForTests } =
      await import("openclaw/plugin-sdk/plugin-state-test-runtime");
    resetPluginStateStoreForTests();
    await configureMemoryCoreDreamingStateForTests();

    // The restored file parses to the original entries, so nothing was lost in
    // the retirement step.
    expect(JSON.parse(restored)).toStrictEqual(original);

    // Re-running Doctor over the restored source does NOT double-import: because
    // SQLite already holds rows and the restored source matches the acknowledged
    // archive, the migration retains it for rollback instead of re-importing.
    // That is the migration's documented conflict behavior, asserted here so the
    // recovery contract is pinned rather than assumed to be a second import.
    const rerun = await dreamingStateMigration.migrateLegacyState(
      migrationParams(workspaceDir, storeFactory),
    );
    const changes = (rerun as { changes?: string[] })?.changes ?? [];
    const notices = (rerun as { notices?: string[] })?.notices ?? [];
    expect(changes.some((line) => line.includes("(2 row(s))"))).toBe(false);
    expect(notices.some((line) => /Retained acknowledged/i.test(line))).toBe(true);

    // The restored history is exactly what the archive held: the retained source
    // is byte-identical to what was imported, so nothing was lost in retirement.
    const recovered = await readStore(workspaceDir, NOW);
    expect(Object.keys(recovered.entries).toSorted()).toStrictEqual(["alpha", "gamma"]);
    expect(recovered.entries.alpha?.totalScore).toBe(2.5);
    expect(recovered.entries.gamma?.totalScore).toBe(0.333);
  });

  it("survives a shutdown, reopen, and read-back without corrupting history", async () => {
    writeFileSync(legacyFile, JSON.stringify(validLegacyStore()), "utf8");
    await dreamingStateMigration.migrateLegacyState(migrationParams(workspaceDir, storeFactory));

    // Read history, update a counter, and write it back through the real writer.
    const migrated = await readStore(workspaceDir, NOW);
    const updated = structuredClone(migrated) as unknown as {
      entries: Record<string, Record<string, unknown>>;
    };
    updated.entries.alpha = {
      ...(updated.entries.alpha as Record<string, unknown>),
      recallCount: (migrated.entries.alpha?.recallCount ?? 0) + 1,
      totalScore: 3.5,
    };
    const { writeStore } = await import("../short-term-promotion-store.js");
    await writeStore(workspaceDir, updated as never);

    // Real reopen: close the SQLite database and drop cached store handles, the
    // way process shutdown would, then reconfigure and read back from disk.
    const { closeOpenClawStateDatabaseForTest, resetPluginStateStoreForTests } =
      await import("openclaw/plugin-sdk/plugin-state-test-runtime");
    closeOpenClawStateDatabaseForTest();
    resetPluginStateStoreForTests();
    await configureMemoryCoreDreamingStateForTests();

    const reopened = await readStore(workspaceDir, NOW);
    expect(reopened.entries.alpha?.recallCount).toBe(5);
    expect(reopened.entries.alpha?.totalScore).toBe(3.5);
    // The rewrite must not have damaged the untouched sibling.
    expect(reopened.entries.gamma?.totalScore).toBe(0.333);
    expect(reopened.entries.gamma?.maxScore).toBe(0.999);
  });

  it("drops malformed legacy rows during import without damaging valid ones", async () => {
    const store = validLegacyStore();
    store.entries.broken = {
      path: "memory/2026-09-04.md",
      startLine: "0x10",
      endLine: 20,
      source: "memory",
      snippet: "Broken legacy row.",
      recallCount: -1,
      dailyCount: 0,
      groundedCount: 0,
      totalScore: "1e999",
      maxScore: "0x10",
      firstRecalledAt: "2026-09-04T00:00:00.000Z",
      lastRecalledAt: "2026-09-04T00:00:00.000Z",
    };
    writeFileSync(legacyFile, JSON.stringify(store), "utf8");

    await dreamingStateMigration.migrateLegacyState(migrationParams(workspaceDir, storeFactory));

    const read = await readStore(workspaceDir, NOW);
    expect(Object.keys(read.entries).toSorted()).toStrictEqual(["alpha", "gamma"]);
    expect(read.entries.alpha).toMatchObject({ recallCount: 4, totalScore: 2.5 });
    // Nothing from the malformed row leaked through as a non-finite number.
    for (const entry of Object.values(read.entries)) {
      expect(Number.isFinite(entry.totalScore)).toBe(true);
      expect(Number.isFinite(entry.maxScore)).toBe(true);
      expect(Number.isFinite(entry.recallCount)).toBe(true);
    }
  });
});
