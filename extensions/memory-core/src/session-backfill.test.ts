import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resolveSessionTranscriptsDirForAgent } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import {
  captureRuntimeConfigAsyncReader,
  clearConfigCache,
  clearRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { normalizeSessionDeliveryState } from "openclaw/plugin-sdk/session-store-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { awaitGateBeforeSettlement } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeBackfillDiaryEntries } from "./dreaming-dreams-file.js";
import { writeSessionIngestionState } from "./dreaming-ingestion-state.js";
import {
  clearMemoryCoreWorkspaceNamespace,
  SESSION_BACKFILL_REWIND_NAMESPACE,
} from "./dreaming-state.js";
import { failMemoryEntryOriginWrites } from "./memory-entry-origins-fault.test-support.js";
import { listMemoryEntryOrigins } from "./memory-entry-origins.js";
import { forgetMemoryEntries } from "./memory-forget.js";
import {
  markSessionBackfillRewindBaseline,
  resetSessionBackfillIngestionState,
  rewindSessionBackfillIngestionState,
} from "./session-backfill-lifecycle.js";
import { executeSessionBackfillBatch, runSessionBackfill } from "./session-backfill.js";
import {
  hashStagedContent,
  seedCanonicalTranscript,
  withoutHostSessionAdmissionReads,
  writeTranscript,
} from "./session-ingestion.test-support.js";
import { readShortTermRecallEntries, recordShortTermRecalls } from "./short-term-promotion.js";
import {
  createMemoryCoreTestHarness,
  dreamingTestState,
  seedMemoryForgetTombstones,
} from "./test-helpers.js";

const harness = createMemoryCoreTestHarness();

function runBackfill(
  workspaceDir: string,
  options: Omit<Parameters<typeof runSessionBackfill>[0], "agentId" | "workspaceDir"> = {},
) {
  return runSessionBackfill({ agentId: "main", workspaceDir, timezone: "UTC", ...options });
}

function ownerMessage(content: string, timestamp = "2026-02-01T10:00:00.000Z") {
  return { role: "user" as const, content, timestamp, owner: true };
}

function seedOwner(sessionId: string, content: string, timestamp?: string) {
  return seedCanonicalTranscript(sessionId, [ownerMessage(content, timestamp)]);
}

function message(role: "user" | "assistant" | "tool", content: string, timestamp: string) {
  return { role, content, timestamp };
}

async function createIsolatedWorkspace(prefix: string): Promise<string> {
  const workspaceDir = await harness.createTempWorkspace(prefix);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(workspaceDir, "state"));
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(workspaceDir, "openclaw.json"));
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  await captureRuntimeConfigAsyncReader()();
  return workspaceDir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
});

describe("runSessionBackfill", () => {
  it("keeps REM preview mode mutually exclusive with apply", async () => {
    const workspaceDir = await createIsolatedWorkspace("rem-apply-");

    await expect(runBackfill(workspaceDir, { rem: true, apply: true })).rejects.toThrow(
      "Memory session-backfill --rem cannot be combined with --apply.",
    );
  });

  it("never resurrects forgotten canonical sessions through session backfill apply", async () => {
    const workspaceDir = await createIsolatedWorkspace("forgotten-");
    await seedOwner(
      "forgotten",
      "Forgotten owner claim must never return.",
      "2026-01-02T12:00:00.000Z",
    );
    await seedOwner(
      "retained",
      "Retained owner claim remains eligible.",
      "2026-01-02T12:01:00.000Z",
    );
    seedMemoryForgetTombstones({ agentId: "main", sessionIds: ["forgotten"] });

    const result = await runBackfill(workspaceDir, { apply: true });

    expect(result.candidateCount).toBe(1);
    expect(result.days[0]?.topCandidates).toEqual(["User: Retained owner claim remains eligible."]);
    const ingestion = await dreamingTestState.readSessionIngestionState(workspaceDir);
    expect(ingestion.files).not.toHaveProperty("main:sessions/main/forgotten");
  });

  it("honors admission exclusions during rem", async () => {
    const workspaceDir = await createIsolatedWorkspace("admission-rem-");
    const sources = [
      { sessionId: "hook", metadata: { hookExternalContentSource: "gmail" as const } },
      {
        sessionId: "channel",
        metadata: {
          delivery: normalizeSessionDeliveryState({
            context: { channel: "discord", to: "channel:admission-fixture" },
            origin: { provider: "discord", to: "channel:admission-fixture" },
          }),
        },
      },
      { sessionId: "group", metadata: { chatType: "group" as const } },
      { sessionId: "retained", metadata: {} },
    ];
    for (const { sessionId, metadata } of sources) {
      await seedCanonicalTranscript(
        sessionId,
        [ownerMessage(`${sessionId} trusted session preference.`, "2026-01-02T12:00:00.000Z")],
        metadata,
      );
    }

    const result = await withoutHostSessionAdmissionReads(() =>
      runBackfill(workspaceDir, {
        rem: true,
        pluginConfig: {
          memoryPolicy: {
            excludeSessions: {
              hookExternalContentSources: ["gmail"],
              channels: ["discord"],
              chatTypes: ["group"],
            },
          },
        },
      }),
    );

    expect(result.candidateCount).toBe(1);
    expect(result.days[0]?.topCandidates).toEqual(["User: retained trusted session preference."]);
  });

  it("keeps a forgotten source out of backfill during admission preparation", async () => {
    const workspaceDir = await createIsolatedWorkspace("admission-source-forgotten-");
    await seedOwner("source", "Do not publish a forgotten source.", "2026-01-02T12:00:00.000Z");
    await closeOpenClawAgentDatabasesAsync(path.join(workspaceDir, "state"));
    const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const realpath = fs.realpath.bind(fs);
    let paused = false;
    const discovery = vi.spyOn(fs, "realpath").mockImplementation(async (file) => {
      if (!paused && file === sessionsDir) {
        paused = true;
        entered.resolve();
        await release.promise;
      }
      return realpath(file);
    });
    const execution = executeSessionBackfillBatch({
      agentId: "main",
      workspaceDir,
      timezone: "UTC",
      pluginConfig: { memoryPolicy: { excludeSessions: { channels: ["discord"] } } },
    });
    const outcome = execution.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        outcome,
        "Backfill settled before filesystem preparation",
      );
      seedMemoryForgetTombstones({ agentId: "main", sessionIds: ["source"] });
      release.resolve();
      expect(await outcome).toMatchObject({
        value: { result: { candidateCount: 0, stagedEntries: 0 } },
      });
      await expect(
        fs.readFile(path.join(workspaceDir, "memory", "2026-01-02.md"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      release.resolve();
      await outcome;
      discovery.mockRestore();
    }
  });

  it("preserves every session origin when backfill coalesces equivalent snippets", async () => {
    const workspaceDir = await createIsolatedWorkspace("coalesced-origins-");
    const sources = [
      { sessionId: "first", role: "assistant", originClass: "agent", hour: "10" },
      { sessionId: "second", role: "user", originClass: "owner", hour: "11" },
    ] as const;
    for (const source of sources) {
      await seedCanonicalTranscript(source.sessionId, [
        ownerMessage("OK", "2026-03-01T09:00:00.000Z"),
        {
          role: source.role,
          content: "The preferred editor is Nova",
          timestamp: `2026-03-01T${source.hour}:00:00.000Z`,
          owner: source.role === "user",
        },
      ]);
    }

    const result = await runBackfill(workspaceDir, { apply: true });
    const entries = await readShortTermRecallEntries({ workspaceDir });

    expect(result.stagedEntries).toBe(1);
    expect(entries).toHaveLength(1);
    expect(
      await listMemoryEntryOrigins({ agentId: "main", entryKeys: [entries[0]!.key] }),
    ).toMatchObject(
      sources.map((source) => ({
        entryKey: entries[0]?.key,
        sessionId: source.sessionId,
        originClass: source.originClass,
        observedAt: Date.parse(`2026-03-01T${source.hour}:00:00.000Z`),
      })),
    );
  });

  it("does not stage already-read session content after its source is forgotten", async () => {
    const workspaceDir = await createIsolatedWorkspace("stale-staging-");
    const result = {
      path: "memory/.dreams/session-corpus/2026-03-01.txt",
      startLine: 1,
      endLine: 1,
      snippet: "The preferred editor is Nova",
      score: 0.9,
      source: "memory" as const,
      sessionOrigin: { agentId: "main", sessionId: "forgotten" },
    };
    seedMemoryForgetTombstones({ agentId: "main", sessionIds: ["forgotten"] });

    await recordShortTermRecalls({
      workspaceDir,
      query: "__dreaming_sessions__:2026-03-01",
      results: [result],
      signalType: "daily",
    });
    await recordShortTermRecalls({
      workspaceDir,
      query: "__dreaming_session_backfill__:2026-03-01",
      signalType: "grounded",
      results: [result],
    });

    expect(await readShortTermRecallEntries({ workspaceDir })).toEqual([]);
    expect(await listMemoryEntryOrigins({ agentId: "main" })).toEqual([]);
  });

  it("reports authoritative continuation across bounded apply batches", async () => {
    const workspaceDir = await createIsolatedWorkspace("continuation-");
    await seedCanonicalTranscript(
      "continuation",
      ["2026-01-01", "2026-01-02", "2026-01-03"].map((day) =>
        ownerMessage(`Continuation note for ${day}`, `${day}T12:00:00.000Z`),
      ),
    );
    const run = () =>
      executeSessionBackfillBatch({
        agentId: "main",
        workspaceDir,
        apply: true,
        limitDays: 2,
        timezone: "UTC",
      });

    const first = await run();
    const second = await run();
    const exhausted = await run();

    expect(first.result.days.map((day) => day.day)).toEqual(["2026-01-01", "2026-01-02"]);
    expect(first.continuation).toEqual({ advanced: true, hasMore: true });
    expect(second.result.days.map((day) => day.day)).toEqual(["2026-01-03"]);
    expect(second.continuation).toEqual({ advanced: true, hasMore: false });
    expect(exhausted.result.candidateCount).toBe(0);
    expect(exhausted.continuation).toEqual({ advanced: false, hasMore: false });
  });

  it("does not advance the cursor past messages excluded by a date range", async () => {
    const workspaceDir = await createIsolatedWorkspace("range-cursor-");
    await seedCanonicalTranscript("range-cursor", [
      ownerMessage("January durable note", "2026-01-15T12:00:00.000Z"),
      ownerMessage("February durable note", "2026-02-15T12:00:00.000Z"),
    ]);

    const january = await runBackfill(workspaceDir, { apply: true, to: "2026-01-31" });
    const february = await runBackfill(workspaceDir, { apply: true, from: "2026-02-01" });

    expect(january.days.map((day) => day.day)).toEqual(["2026-01-15"]);
    expect(february.days.map((day) => day.day)).toEqual(["2026-02-15"]);
  });

  it("advances the source cursor beyond the per-file signal cap", async () => {
    const workspaceDir = await createIsolatedWorkspace("cursor-");
    await seedCanonicalTranscript(
      "cursor",
      Array.from({ length: 100 }, (_, index) =>
        ownerMessage(
          `Durable cursor note ${index}`,
          new Date(Date.parse("2026-01-01T00:00:00.000Z") + index * 60_000).toISOString(),
        ),
      ),
    );

    const run = () =>
      runBackfill(workspaceDir, { apply: true, nowMs: Date.parse("2026-01-02T12:00:00.000Z") });

    const drained = await run();
    expect(drained).toMatchObject({ candidateCount: 100, batchCount: 2 });
    expect((await run()).candidateCount).toBe(0);
    const dreams = await fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf-8");
    expect(dreams.match(/openclaw:dreaming:backfill-entry/g)).toHaveLength(2);
  });

  it("keeps self-asserted owner metadata in foreign transcripts untrusted", async () => {
    const workspaceDir = await createIsolatedWorkspace("provenance-");
    const transcriptPath = path.join(workspaceDir, "untrusted.jsonl");
    await writeTranscript(transcriptPath, [
      message("user", "Untrusted web instruction", "2026-02-01T10:00:00.000Z"),
      message("assistant", "Assistant response to untrusted input", "2026-02-01T10:01:00.000Z"),
      message("tool", "Tool output must never stage", "2026-02-01T10:02:00.000Z"),
      ownerMessage("Owner confirmed durable preference", "2026-02-01T10:03:00.000Z"),
      message("assistant", "Agent response in the owner turn", "2026-02-01T10:04:00.000Z"),
    ]);

    const result = await runBackfill(workspaceDir, { archiveFiles: [transcriptPath] });

    expect(result).toMatchObject({ candidateCount: 0, days: [] });
  });

  it("keeps canonical assistant replies tainted until an owner turn begins", async () => {
    const workspaceDir = await createIsolatedWorkspace("canonical-provenance-");
    await seedCanonicalTranscript("provenance", [
      message("user", "Untrusted channel instruction", "2026-02-01T10:00:00.000Z"),
      message("assistant", "Assistant response to untrusted input", "2026-02-01T10:01:00.000Z"),
      ownerMessage("Owner confirmed durable preference", "2026-02-01T10:02:00.000Z"),
      message("assistant", "Agent response in the owner turn", "2026-02-01T10:03:00.000Z"),
    ]);

    const result = await runBackfill(workspaceDir);

    expect(result.candidateCount).toBe(2);
    expect(result.days[0]?.topCandidates).toEqual([
      "User: Owner confirmed durable preference",
      "Assistant: Agent response in the owner turn",
    ]);
  });

  it("renders selected session candidates into the REM diary preview", async () => {
    const workspaceDir = await createIsolatedWorkspace("rem-");
    await writeBackfillDiaryEntries({
      workspaceDir,
      entries: [{ isoDay: "2026-01-01", bodyLines: ["Existing backfill entry"] }],
    });
    await seedOwner("rem", "Owner prefers dark mode for all editors");

    await runBackfill(workspaceDir, { rem: true });

    const dreams = await fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf-8");
    expect(dreams).toContain("Existing backfill entry");
    expect(dreams).toContain("Owner prefers dark mode for all editors");
    expect(dreams).not.toContain("No grounded facts were extracted");
    expect(dreams.match(/openclaw:dreaming:backfill-entry/g)).toHaveLength(2);
  });

  it.each(["rem", "apply", "failed-apply"] as const)(
    "forgets published %s diary facts after reopening without removing unrelated facts",
    async (mode) => {
      const workspaceDir = await createIsolatedWorkspace(`forget-${mode}-`);
      const cfg = { agents: { defaults: { workspace: workspaceDir }, entries: { main: {} } } };
      const diaryPath = path.join(workspaceDir, "DREAMS.md");
      const operatorNote = "Keep this unrelated operator note.";
      await fs.writeFile(diaryPath, `# Dream Diary\n${operatorNote}\n`);
      for (const [sessionId, content] of [
        ["target", "Owner prefers **cobalt lanterns**; always use green tea."],
        ["retained", "Owner prefers silver ribbons for invitations."],
      ]) {
        await seedOwner(sessionId!, content!);
      }
      const corpusParent = path.join(workspaceDir, "memory", ".dreams");
      if (mode === "failed-apply") {
        await fs.mkdir(path.dirname(corpusParent), { recursive: true });
        await fs.writeFile(corpusParent, "block the corpus write");
      }
      const backfill = runBackfill(workspaceDir, { rem: mode === "rem", apply: mode !== "rem" });
      if (mode === "failed-apply") {
        await expect(backfill).rejects.toThrow();
        await fs.unlink(corpusParent);
      } else {
        await backfill;
      }
      const before = await fs.readFile(diaryPath, "utf8");
      expect(before).toContain("cobalt lanterns");
      expect(before).toContain("silver ribbons");
      if (mode === "rem") {
        expect(before).not.toContain("**cobalt lanterns**");
        expect(await readShortTermRecallEntries({ workspaceDir })).toEqual([]);
        expect((await dreamingTestState.readSessionIngestionState(workspaceDir)).files).toEqual({});
        await expect(fs.stat(corpusParent)).rejects.toMatchObject({ code: "ENOENT" });
        const origins = await listMemoryEntryOrigins({ agentId: "main" });
        expect(origins.every(({ entryKey }) => before.includes(entryKey))).toBe(true);
        const repeated = await runBackfill(workspaceDir, { rem: true });
        expect(repeated.writtenDiaryEntries).toBe(0);
        expect(await listMemoryEntryOrigins({ agentId: "main" })).toEqual(origins);
      }
      await closeOpenClawAgentDatabasesAsync();
      closeOpenClawAgentDatabasesForTest();
      const preview = await forgetMemoryEntries({
        cfg,
        agentId: "main",
        sessionIds: ["target"],
        dryRun: true,
      });
      expect(await fs.readFile(diaryPath, "utf8")).toBe(before);
      const report = await forgetMemoryEntries({ cfg, agentId: "main", sessionIds: ["target"] });
      expect(report.artifacts).toEqual(preview.artifacts);
      const after = await fs.readFile(diaryPath, "utf8");
      expect.soft(after).not.toContain("cobalt lanterns");
      expect.soft(after).not.toContain("green tea");
      expect(after).toContain("silver ribbons");
      expect(after).toContain(operatorNote);
      expect(report.refusals).toEqual([]);
      const repeated = await forgetMemoryEntries({ cfg, agentId: "main", sessionIds: ["target"] });
      expect(Object.values(repeated.artifacts).every((count) => count === 0)).toBe(true);
    },
  );

  it("retains both origins when diary publication deduplicates identical apply blocks", async () => {
    const workspaceDir = await createIsolatedWorkspace("diary-dedupe-");
    const cfg = { agents: { defaults: { workspace: workspaceDir }, entries: { main: {} } } };
    for (const sessionId of ["first", "second"]) {
      await seedOwner(sessionId, "Owner prefers cobalt lanterns.");
      const applied = await runBackfill(workspaceDir, { apply: true });
      expect(applied.writtenDiaryEntries).toBe(sessionId === "first" ? 1 : 0);
    }
    const diaryPath = path.join(workspaceDir, "DREAMS.md");
    expect(await fs.readFile(diaryPath, "utf8")).toContain("cobalt lanterns");
    const report = await forgetMemoryEntries({ cfg, agentId: "main", sessionIds: ["second"] });
    expect(report.mixedLineageEntryKeys.length).toBeGreaterThan(0);
    expect(await fs.readFile(diaryPath, "utf8")).not.toContain("cobalt lanterns");
  });

  it("keeps all origins of a coalesced REM claim while preserving independent facts", async () => {
    const workspaceDir = await createIsolatedWorkspace("rem-coalesced-");
    const cfg = { agents: { defaults: { workspace: workspaceDir }, entries: { main: {} } } };
    for (const [sessionId, item] of [
      ["first", "cobalt lanterns"],
      ["second", "silver ribbons"],
    ] as const) {
      await seedOwner(sessionId, `Owner prefers ${item}; always use green tea.`);
    }
    await runBackfill(workspaceDir, { rem: true });
    const diaryPath = path.join(workspaceDir, "DREAMS.md");
    const before = await fs.readFile(diaryPath, "utf8");
    expect(before).toContain("- [likely_durable] always use green tea.");
    const report = await forgetMemoryEntries({ cfg, agentId: "main", sessionIds: ["second"] });
    const after = await fs.readFile(diaryPath, "utf8");
    expect(report.mixedLineageEntryKeys.length).toBeGreaterThan(0);
    expect(after).toContain("cobalt lanterns");
    expect(after).not.toContain("silver ribbons");
    expect(after).not.toContain("- [likely_durable] always use green tea.");
  });

  it("does not publish a diary when reserving its origins fails", async () => {
    const workspaceDir = await createIsolatedWorkspace("diary-origin-failure-");
    await seedOwner("target", "Owner prefers cobalt lanterns.");
    const diaryPath = path.join(workspaceDir, "DREAMS.md");
    await fs.writeFile(diaryPath, "Keep this operator note.\n");
    const restoreOriginFailure = failMemoryEntryOriginWrites({
      agentId: "main",
      trigger: "reject_diary_origin",
      createSql: `
        CREATE TRIGGER reject_diary_origin BEFORE INSERT ON memory_entry_origins
        BEGIN SELECT RAISE(ABORT, 'injected diary origin failure'); END;
      `,
    });
    try {
      await expect(runBackfill(workspaceDir, { rem: true })).rejects.toThrow(
        "injected diary origin failure",
      );
      expect(await fs.readFile(diaryPath, "utf8")).toBe("Keep this operator note.\n");
    } finally {
      restoreOriginFailure();
    }
  });

  it("stages idempotently, converges duplicate facts, and rolls back staged artifacts", async () => {
    const workspaceDir = await createIsolatedWorkspace("apply-");
    await seedCanonicalTranscript("repeat", [
      {
        role: "user",
        content: "The preferred editor is Nova",
        timestamp: "2026-03-01T10:00:00.000Z",
        owner: true,
      },
      {
        role: "user",
        content: "The preferred editor is Nova",
        timestamp: "2026-03-01T11:00:00.000Z",
        owner: true,
      },
    ]);

    const first = await runSessionBackfill({
      agentId: "main",
      workspaceDir,
      apply: true,
      nowMs: Date.parse("2026-03-02T12:00:00.000Z"),
      timezone: "UTC",
    });
    const afterFirst = await readShortTermRecallEntries({ workspaceDir });
    const firstContentHash = hashStagedContent(afterFirst);

    // Count-level proof stays stable across the sibling claim-key implementation.
    expect(first.stagedEntries).toBe(1);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]?.snippet).toBe("The preferred editor is Nova");

    const second = await runSessionBackfill({
      agentId: "main",
      workspaceDir,
      apply: true,
      nowMs: Date.parse("2026-03-02T12:00:00.000Z"),
      timezone: "UTC",
    });
    expect(second.candidateCount).toBe(0);
    expect(second.stagedEntries).toBe(0);
    expect(await readShortTermRecallEntries({ workspaceDir })).toHaveLength(1);

    const dreamsPath = path.join(workspaceDir, "DREAMS.md");
    expect(await fs.readFile(dreamsPath, "utf-8")).toContain("openclaw:dreaming:backfill-entry");

    const rollback = await runSessionBackfill({
      agentId: "main",
      workspaceDir,
      rollback: true,
    });
    expect(rollback.rollback).toEqual({
      removedDiaryEntries: 1,
      removedStagedEntries: 1,
    });
    expect(await readShortTermRecallEntries({ workspaceDir })).toHaveLength(0);
    expect(await fs.readFile(dreamsPath, "utf-8")).not.toContain(
      "openclaw:dreaming:backfill-entry",
    );
    const reapplied = await runSessionBackfill({
      agentId: "main",
      workspaceDir,
      apply: true,
      nowMs: Date.parse("2026-03-02T12:00:00.000Z"),
      timezone: "UTC",
    });
    const afterReapply = await readShortTermRecallEntries({ workspaceDir });
    expect(reapplied.candidateCount).toBe(2);
    expect(hashStagedContent(afterReapply)).toBe(firstContentHash);
  });

  it("resets agent ingestion state when legacy staged entries have no rewind journal", async () => {
    const workspaceDir = await createIsolatedWorkspace("legacy-rollback-");
    await seedOwner("legacy", "The preferred terminal is Ghostty", "2026-04-01T10:00:00.000Z");
    const apply = () =>
      runBackfill(workspaceDir, { apply: true, nowMs: Date.parse("2026-04-02T12:00:00.000Z") });

    await apply();
    const firstContentHash = hashStagedContent(await readShortTermRecallEntries({ workspaceDir }));
    await clearMemoryCoreWorkspaceNamespace({
      namespace: SESSION_BACKFILL_REWIND_NAMESPACE,
      workspaceDir,
    });

    const rollback = await runSessionBackfill({ agentId: "main", workspaceDir, rollback: true });
    const preview = await runBackfill(workspaceDir);
    const reapplied = await apply();
    const afterReapply = await readShortTermRecallEntries({ workspaceDir });

    expect(rollback.rollback).toEqual({ removedDiaryEntries: 1, removedStagedEntries: 1 });
    expect(preview.candidateCount).toBe(1);
    expect(reapplied.candidateCount).toBe(1);
    expect(hashStagedContent(afterReapply)).toBe(firstContentHash);

    const stateAfterReapply = await dreamingTestState.readSessionIngestionState(workspaceDir);
    const scope = Object.keys(stateAfterReapply.seenMessages)[0];
    if (!scope) {
      throw new Error("Expected re-applied session ingestion scope");
    }
    await writeSessionIngestionState(workspaceDir, {
      ...stateAfterReapply,
      seenMessages: {
        ...stateAfterReapply.seenMessages,
        [scope]: [...(stateAfterReapply.seenMessages[scope] ?? []), "later-live"],
      },
    });
    await runSessionBackfill({ agentId: "main", workspaceDir, rollback: true });
    expect(
      (await dreamingTestState.readSessionIngestionState(workspaceDir)).seenMessages[scope],
    ).toEqual(["later-live"]);
  });

  it("resets mixed legacy state when later journal rows do not prove complete coverage", async () => {
    const workspaceDir = await createIsolatedWorkspace("mixed-legacy-rollback-");
    const apply = () =>
      runBackfill(workspaceDir, { apply: true, nowMs: Date.parse("2026-05-03T12:00:00.000Z") });
    await seedOwner("legacy-mixed", "The preferred shell is zsh", "2026-05-01T10:00:00.000Z");
    await apply();
    await clearMemoryCoreWorkspaceNamespace({
      namespace: SESSION_BACKFILL_REWIND_NAMESPACE,
      workspaceDir,
    });
    await seedOwner("journaled-mixed", "The preferred pager is less", "2026-05-02T10:00:00.000Z");
    await apply();
    const firstContentHash = hashStagedContent(await readShortTermRecallEntries({ workspaceDir }));

    await runSessionBackfill({ agentId: "main", workspaceDir, rollback: true });
    const preview = await runBackfill(workspaceDir);
    const reapplied = await apply();

    expect(preview.candidateCount).toBe(2);
    expect(reapplied.candidateCount).toBe(2);
    expect(hashStagedContent(await readShortTermRecallEntries({ workspaceDir }))).toBe(
      firstContentHash,
    );
  });

  it("keeps other agents' archived scopes when resetting an agent named archive", async () => {
    const workspaceDir = await createIsolatedWorkspace("archive-agent-reset-");
    const fileState = {
      mtimeMs: 1,
      size: 1,
      contentHash: "hash",
      lineCount: 1,
      lastContentLine: 1,
    };
    await writeSessionIngestionState(workspaceDir, {
      version: 3,
      files: {
        "archive:sessions/archive/own": fileState,
        "main:sessions/main/other": fileState,
      },
      seenMessages: {
        "archive:sessions/archive/own": ["own-live"],
        "archive:archive:/tmp/own.jsonl": ["own-archive"],
        "archive:main:/tmp/other.jsonl": ["other-archive"],
        "main:sessions/main/other": ["other-live"],
      },
    });

    await resetSessionBackfillIngestionState({ workspaceDir, agentId: "archive" });

    expect(await dreamingTestState.readSessionIngestionState(workspaceDir)).toEqual({
      version: 3,
      files: { "main:sessions/main/other": fileState },
      seenMessages: {
        "archive:main:/tmp/other.jsonl": ["other-archive"],
        "main:sessions/main/other": ["other-live"],
      },
    });
  });

  it("does not share a clean rewind baseline across agents", async () => {
    const workspaceDir = await createIsolatedWorkspace("agent-baseline-");
    await markSessionBackfillRewindBaseline({ workspaceDir, agentId: "main" });

    expect(await rewindSessionBackfillIngestionState({ workspaceDir, agentId: "other" })).toEqual({
      completeCoverage: false,
      rewoundCandidates: 0,
    });
    expect(await rewindSessionBackfillIngestionState({ workspaceDir, agentId: "main" })).toEqual({
      completeCoverage: true,
      rewoundCandidates: 0,
    });
  });
});
