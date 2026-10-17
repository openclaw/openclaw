import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { openOpenClawAgentDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DREAMING_MEMORY_BACKUP_NAMESPACE,
  readMemoryCoreWorkspaceEntries,
} from "./dreaming-state.js";
import { failMemoryEntryOriginWrites } from "./memory-entry-origins-fault.test-support.js";
import { listMemoryEntryOrigins, recordMemoryEntryOrigins } from "./memory-entry-origins.js";
import { forgetMemoryEntries } from "./memory-forget.js";
import { createMemoryForgetFixture } from "./memory-forget.test-helpers.js";
import {
  applyShortTermPromotions,
  rankShortTermPromotionCandidates,
  readShortTermRecallEntries,
  recordShortTermRecalls,
} from "./short-term-promotion.js";

describe("memory forget", () => {
  const forget = (
    selectors: Omit<Parameters<typeof forgetMemoryEntries>[0], "cfg" | "agentId">,
    agentId = "main",
  ) => forgetMemoryEntries({ cfg, agentId, ...selectors });
  const origins = (agentId: string, entryKey: string) =>
    listMemoryEntryOrigins({ agentId, entryKeys: [entryKey] });
  const readBackups = () =>
    readMemoryCoreWorkspaceEntries<{ content: string }>({
      namespace: DREAMING_MEMORY_BACKUP_NAMESPACE,
      workspaceDir,
    });
  const readText = (file: string) => fs.readFile(file, "utf8");
  let fixture: Awaited<ReturnType<typeof createMemoryForgetFixture>>;
  let workspaceDir: string;
  let cfg: OpenClawConfig;

  beforeEach(async () => {
    fixture = await createMemoryForgetFixture();
    ({ workspaceDir, cfg } = fixture);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fixture.cleanup();
  });

  async function seedSession(sessionId: string): Promise<void> {
    await upsertSessionEntry({
      agentId: "main",
      sessionKey: `agent:main:${sessionId}`,
      entry: { sessionId, updatedAt: 1_000 },
    });
  }

  it.each([
    { action: "superseded", failOrigins: false, fileFailure: "none" },
    { action: "merged", failOrigins: true, fileFailure: "none" },
    { action: "merged", failOrigins: false, fileFailure: "close-permission" },
    { action: "merged", failOrigins: false, fileFailure: "rename-unchanged" },
    { action: "merged", failOrigins: false, fileFailure: "rename-changed" },
    { action: "merged", failOrigins: false, fileFailure: "rename-unreadable" },
    { action: "merged", failOrigins: false, fileFailure: "rename-published" },
  ] as const)(
    "preserves workspace deletion lineage for $action (origin failure: $failOrigins, file failure: $fileFailure)",
    async ({ action, failOrigins, fileFailure }) => {
      cfg = {
        agents: {
          defaults: { workspace: workspaceDir },
          entries: {
            alpha: { workspace: workspaceDir },
            gamma: { workspace: workspaceDir },
            vacant: { workspace: workspaceDir },
          },
        },
      } as OpenClawConfig;
      setRuntimeConfigSnapshot(cfg);
      await upsertSessionEntry({
        agentId: "gamma",
        sessionKey: "agent:gamma:private-session",
        entry: { sessionId: "private-session", updatedAt: 1_000 },
      });
      const priorEntry = "- The launch code is violet.";
      const snippet =
        action === "merged" ? "The launch code is violet." : "The launch code is cobalt.";
      const memoryPath = path.join(workspaceDir, "MEMORY.md");
      const diaryPath = path.join(workspaceDir, "DREAMS.md");
      await fs.writeFile(diaryPath, "# Dream Diary\nKeep this unrelated diary entry.\n");
      const previousMemory = [
        "# Long-Term Memory",
        ...(action === "superseded" ? ["<!-- openclaw-memory-lineage:launch-code -->"] : []),
        "<!-- openclaw-memory-promotion:retired-entry -->",
        priorEntry,
        "",
      ].join("\n");
      await fs.writeFile(memoryPath, previousMemory);
      const notePath = path.join(workspaceDir, "memory", "2026-08-26.md");
      await fs.mkdir(path.dirname(notePath), { recursive: true });
      await fs.writeFile(notePath, `${snippet}\n`);
      await recordMemoryEntryOrigins({
        agentId: "gamma",
        origins: [
          {
            entryKey: "retired-entry",
            agentId: "gamma",
            sessionId: "private-session",
            sessionKey: "agent:gamma:private-session",
            originClass: "owner",
            observedAt: 1_000,
          },
        ],
      });
      const vacantDb = openOpenClawAgentDatabase({ agentId: "vacant" }).db;
      vacantDb.exec("DROP TABLE IF EXISTS memory_entry_origins");
      const nowMs = Date.parse("2026-08-26T12:00:00.000Z");
      await recordShortTermRecalls({
        workspaceDir,
        query: "launch code",
        signalType: "daily",
        nowMs,
        results: [
          {
            path: "memory/2026-08-26.md",
            startLine: 1,
            endLine: 1,
            score: 0.9,
            snippet,
            source: "memory",
            provenance: {
              originClass: "owner",
              sessionKind: "interactive",
              observedAt: nowMs,
              ...(action === "superseded" ? { supersedesKey: "launch-code" } : {}),
            },
            sessionOrigin: {
              agentId: "alpha",
              sessionId: "alpha-session",
              sessionKey: "agent:alpha:alpha-session",
            },
          },
        ],
      });
      const thresholds = { minScore: 0, minRecallCount: 0, minUniqueQueries: 0 };
      const candidates = await rankShortTermPromotionCandidates({
        workspaceDir,
        nowMs,
        ...thresholds,
      });
      const promoted = candidates[0];
      expect(promoted).toBeDefined();
      const output = JSON.stringify({
        operations: [{ candidateKey: promoted!.key, action, priorEntries: [priorEntry] }],
      });
      const subagent = {
        complete: vi.fn(async () => ({ text: output })),
      };

      const restoreOriginFailure = failOrigins
        ? failMemoryEntryOriginWrites({
            agentId: "gamma",
            trigger: "fail_origin_reservation",
            createSql: `
              CREATE TRIGGER fail_origin_reservation BEFORE INSERT ON memory_entry_origins
              WHEN NEW.entry_key != 'retired-entry'
              BEGIN SELECT RAISE(ABORT, 'injected origin write failure'); END;
            `,
          })
        : undefined;
      let renamed = false;
      let fileFaultInjected = false;
      let memoryRenameCalls = 0;
      let readbackBlocked = false;
      const fileError = Object.assign(new Error("synthetic atomic memory failure"), {
        code: "EPERM",
        errno: -1,
      });
      const externalMemory = "# Memory\n\nKeep this newer external edit.\n";
      if (fileFailure !== "none") {
        const rename = fs.rename.bind(fs);
        const open = fs.open.bind(fs);
        const readFile = fs.readFile.bind(fs);
        vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
          if (readbackBlocked && args[0] === memoryPath) {
            throw Object.assign(new Error("synthetic unavailable rename readback"), {
              code: "EIO",
            });
          }
          return await readFile(...args);
        });
        vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
          if (String(to) === memoryPath) {
            memoryRenameCalls += 1;
            if (!fileFaultInjected && fileFailure.startsWith("rename-")) {
              fileFaultInjected = true;
              if (fileFailure === "rename-published") {
                await rename(from, to);
                renamed = true;
              } else if (fileFailure === "rename-changed") {
                await fs.writeFile(memoryPath, externalMemory);
              } else if (fileFailure === "rename-unreadable") {
                readbackBlocked = true;
              }
              throw fileError;
            }
            await rename(from, to);
            renamed = true;
          } else {
            await rename(from, to);
          }
        });
        vi.spyOn(fs, "open").mockImplementation(async (...args) => {
          const handle = await open(...args);
          if (
            fileFailure.startsWith("close") &&
            path.basename(String(args[0])).startsWith("MEMORY.md.promotion.")
          ) {
            const close = handle.close.bind(handle);
            handle.close = async () => {
              await close();
              if (renamed && !fileFaultInjected) {
                fileFaultInjected = true;
                throw fileError;
              }
            };
          }
          return handle;
        });
      }
      const application = applyShortTermPromotions({
        agentId: "alpha",
        workspaceAgentIds: ["vacant", "gamma", "alpha", "gamma"],
        workspaceDir,
        candidates,
        consolidation: { subagent, logger: { info: vi.fn(), warn: vi.fn() } },
        maxPriorEntryLossFraction: 1,
        nowMs,
        ...thresholds,
      });
      if (fileFailure === "rename-unchanged") {
        const applied = await application;
        expect(applied.applied).toBe(1);
        expect(memoryRenameCalls).toBe(2);
        const memory = await readText(memoryPath);
        expect(memory).toContain("openclaw-memory-promotion:retired-entry");
        expect(memory).toContain(`openclaw-memory-promotion:${promoted!.key}`);
        expect(await origins("gamma", promoted!.key)).toEqual([]);
        await forget({ sessionIds: ["private-session"] }, "gamma");
        expect(await readText(memoryPath)).toContain(`openclaw-memory-promotion:${promoted!.key}`);
        return;
      }
      if (fileFailure !== "none") {
        const failed = await application.then(
          () => {
            throw new Error("expected the atomic publication failure");
          },
          (error: unknown) => error,
        );
        readbackBlocked = false;
        expect(failed).toMatchObject({
          message: fileError.message,
          name: fileError.name,
          code: "EPERM",
          cause: fileError,
        });
        expect(failed).toMatchObject({ cause: { errno: -1 } });
        expect(fileFaultInjected).toBe(true);
        expect(memoryRenameCalls).toBe(1);
        const published = fileFailure.startsWith("close") || fileFailure === "rename-published";
        expect(renamed).toBe(published);
        if (published) {
          expect(await readText(memoryPath)).toContain(
            `openclaw-memory-promotion:${promoted!.key}`,
          );
        } else {
          expect(await readText(memoryPath)).toBe(
            fileFailure === "rename-changed" ? externalMemory : previousMemory,
          );
        }
        expect(
          (await readShortTermRecallEntries({ workspaceDir, nowMs }))[0]?.promotedAt,
        ).toBeUndefined();
        expect((await readBackups()).map(({ value }) => value.content)).toEqual([previousMemory]);
        expect(await origins("gamma", "retired-entry")).toHaveLength(1);
        expect(await origins("gamma", promoted!.key)).toMatchObject([
          { entryKey: promoted!.key, sessionId: "private-session" },
        ]);
        const report = await forget({ sessionIds: ["private-session"] }, "gamma");
        expect(report.entryKeys).toContain(promoted!.key);
        expect(await readText(memoryPath)).not.toContain(
          `openclaw-memory-promotion:${promoted!.key}`,
        );
        expect(await origins("gamma", promoted!.key)).toEqual([]);
        return;
      }
      if (failOrigins) {
        try {
          await expect(application).rejects.toThrow("injected origin write failure");
          await expect(readText(memoryPath)).resolves.toBe(previousMemory);
          expect(
            (await readShortTermRecallEntries({ workspaceDir, nowMs }))[0]?.promotedAt,
          ).toBeUndefined();
        } finally {
          restoreOriginFailure?.();
        }
        return;
      }
      const applied = await application;

      expect(applied.applied).toBe(1);
      expect(await origins("gamma", promoted!.key)).toMatchObject([
        { entryKey: promoted!.key, sessionId: "private-session" },
      ]);
      expect((await readBackups()).map(({ value }) => value.content)).toEqual([
        expect.stringContaining(priorEntry),
      ]);
      expect(
        vacantDb
          .prepare("SELECT name FROM sqlite_schema WHERE name = 'memory_entry_origins'")
          .get(),
      ).toBeUndefined();

      expect(await readText(diaryPath)).toContain(snippet);
      await closeOpenClawAgentDatabasesAsync();
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      resetPluginStateStoreForTests();
      const report = await forget({ sessionIds: ["private-session"] }, "gamma");
      expect(report).toMatchObject({
        entryKeys: expect.arrayContaining([promoted!.key]),
        artifacts: { memoryEntries: 3, backups: 1 },
      });
      expect(await readText(memoryPath)).not.toContain(snippet);
      expect((await readBackups()).every(({ value }) => !value.content.includes(priorEntry))).toBe(
        true,
      );
      expect(await listMemoryEntryOrigins({ agentId: "gamma" })).toEqual([]);
      const diary = await readText(diaryPath);
      expect.soft(diary).not.toContain(priorEntry);
      expect.soft(diary).not.toContain(snippet);
      expect(diary).toContain("Keep this unrelated diary entry.");
      expect(report.refusals).toEqual([]);
      const repeated = await forget({ sessionIds: ["private-session"] }, "gamma");
      expect(Object.values(repeated.artifacts).every((count) => count === 0)).toBe(true);
    },
  );

  it.each(["DREAMS.md"])(
    "warns and preserves historical untraceable highlights in %s",
    async (diaryName) => {
      await seedSession("target");
      await recordMemoryEntryOrigins({
        agentId: "main",
        origins: [
          {
            entryKey: "historical",
            agentId: "main",
            sessionId: "target",
            sessionKey: "agent:main:target",
            originClass: "owner",
            observedAt: 1_000,
          },
        ],
      });
      const diaryPath = path.join(workspaceDir, diaryName);
      const historical =
        "# Dream Diary\n## Memory Consolidation History\n- Highlights:\n  - `+ <!-- openclaw-memory-promotion:historical -->`\n  - `+ Untraceable historical fact.`\n";
      await fs.writeFile(diaryPath, historical);
      const preview = await forget({ sessionIds: ["target"], dryRun: true });
      expect(preview.refusals).toEqual([expect.stringContaining("review them manually")]);
      expect(preview.artifacts.memoryFiles).toBe(0);
      const report = await forget({ sessionIds: ["target"] });
      expect(report.refusals).toEqual(preview.refusals);
      expect(await readText(diaryPath)).toBe(historical);
      const repeated = await forget({ sessionIds: ["target"], dryRun: true });
      expect(repeated.refusals).toEqual(preview.refusals);
    },
  );

  it("removes only the selected historical session highlight, not its following sibling", async () => {
    await seedSession("target");
    const diaryPath = path.join(workspaceDir, "DREAMS.md");
    const selected =
      "  - `+ Session ID: target; Selected private fact.`\n    Selected continuation.";
    const survivor =
      "  - `+ Keep this unrelated historical fact.`\n<!-- openclaw-memory-promotion:unrelated -->\n- Unrelated adjacent marked entry.";
    const heading = "## Memory Consolidation History\n";
    await fs.writeFile(diaryPath, `${heading}${selected}\n${survivor}\n`);
    const report = await forget({ sessionIds: ["target"] });
    expect(await readText(diaryPath)).toBe(`${heading}${survivor}\n`);
    expect(report.refusals).toEqual([expect.stringContaining("review them manually")]);
  });

  it("removes a marker-addressable plain-append promotion after budget compaction", async () => {
    await seedSession("target");
    const nowMs = Date.parse("2026-08-25T12:00:00.000Z");
    const snippet = "The undisclosed launch code is cobalt.";
    const sourcePath = "memory/2026-08-25.md";
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, sourcePath), `${snippet}\n`);
    await fs.writeFile(
      path.join(workspaceDir, "MEMORY.md"),
      [
        "# Long-Term Memory",
        "Curated operator fact.",
        "",
        "## Promoted From Short-Term Memory (2026-08-24)",
        "<!-- openclaw-memory-promotion:older-entry -->",
        `- ${"x".repeat(500)}`,
        "",
      ].join("\n"),
    );
    await recordShortTermRecalls({
      workspaceDir,
      query: "launch code",
      signalType: "daily",
      nowMs,
      results: [
        {
          path: sourcePath,
          startLine: 1,
          endLine: 1,
          score: 0.9,
          snippet,
          source: "memory",
          provenance: { originClass: "owner", sessionKind: "interactive", observedAt: nowMs },
          sessionOrigin: {
            agentId: "main",
            sessionId: "target",
            sessionKey: "agent:main:target",
          },
        },
      ],
    });
    const thresholds = { minScore: 0, minRecallCount: 0, minUniqueQueries: 0 };
    const candidates = await rankShortTermPromotionCandidates({
      workspaceDir,
      nowMs,
      ...thresholds,
    });
    const candidateKey = candidates[0]?.key;
    expect(candidateKey).toMatch(/^memory:claim:/);

    const promoted = await applyShortTermPromotions({
      agentId: "main",
      workspaceDir,
      candidates,
      nowMs,
      memoryFileMaxChars: 450,
      maxPriorEntryLossFraction: 1,
      ...thresholds,
    });
    expect(promoted.appended).toBe(1);
    expect(promoted.compactedDates).toEqual(["2026-08-24"]);
    const promotedMemory = await readText(path.join(workspaceDir, "MEMORY.md"));
    expect(promotedMemory).toContain(`<!-- openclaw-memory-promotion:${candidateKey} -->`);
    expect(promotedMemory).toContain(snippet);

    const report = await forget({ sessionIds: ["target"] });

    expect(report).toMatchObject({
      entryKeys: [candidateKey],
      artifacts: { memoryFiles: 1, memoryEntries: 1, shortTermEntries: 1, originRows: 1 },
    });
    const survivingMemory = await readText(path.join(workspaceDir, "MEMORY.md"));
    expect(survivingMemory).toContain("Curated operator fact.");
    expect(survivingMemory).not.toContain(snippet);
    expect(survivingMemory).not.toContain(candidateKey);
  });
});
