import fs from "node:fs/promises";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { createOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { listMemoryArtifactProvenance } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { openOpenClawAgentDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { describe, expect, it, vi } from "vitest";
import { DREAMING_MEMORY_BACKUP_NAMESPACE } from "./dreaming-state.js";
import { failMemoryEntryOriginWrites } from "./memory-entry-origins-fault.test-support.js";
import { listMemoryEntryOrigins } from "./memory-entry-origins.js";
import { memoryForgetHarness, memoryOrigin } from "./memory-forget.suite.test-support.js";
import {
  applyShortTermPromotions,
  rankShortTermPromotionCandidates,
  readShortTermRecallEntries,
  recordShortTermRecalls,
} from "./short-term-promotion.js";

const h = memoryForgetHarness();

describe("memory forget", () => {
  const { forget, readText } = h;
  const origins = (agentId: string, entryKey: string) =>
    h.origins({ entryKeys: [entryKey] }, agentId);

  const readBackups = () => h.readEntries<{ content: string }>(DREAMING_MEMORY_BACKUP_NAMESPACE);

  const thresholds = { minScore: 0, minRecallCount: 0, minUniqueQueries: 0 };
  async function candidatesFor(
    sourcePath: string,
    snippet: string,
    nowMs: number,
    sessionId = "target",
    agentId = "main",
    supersedesKey?: string,
  ) {
    await recordShortTermRecalls({
      workspaceDir: h.workspaceDir,
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
          provenance: {
            originClass: "owner",
            sessionKind: "interactive",
            observedAt: nowMs,
            ...(supersedesKey ? { supersedesKey } : {}),
          },
          sessionOrigin: { agentId, sessionId, sessionKey: `agent:${agentId}:${sessionId}` },
        },
      ],
    });
    return rankShortTermPromotionCandidates({ workspaceDir: h.workspaceDir, nowMs, ...thresholds });
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
      h.cfg = {
        agents: {
          defaults: { workspace: h.workspaceDir },
          entries: {
            alpha: { workspace: h.workspaceDir },
            gamma: { workspace: h.workspaceDir },
            vacant: { workspace: h.workspaceDir },
          },
        },
      } as OpenClawConfig;
      setRuntimeConfigSnapshot(h.cfg);
      await h.seedSession("private-session", "gamma");
      const priorEntry = "- The launch code is violet.";
      const snippet =
        action === "merged" ? "The launch code is violet." : "The launch code is cobalt.";
      const memoryPath = h.path("MEMORY.md");
      const diaryPath = h.path("DREAMS.md");
      await fs.writeFile(diaryPath, "# Dream Diary\nKeep this unrelated diary entry.\n");
      const previousMemory =
        "# Long-Term Memory\n" +
        (action === "superseded" ? "<!-- openclaw-memory-lineage:launch-code -->\n" : "") +
        `<!-- openclaw-memory-promotion:retired-entry -->\n${priorEntry}\n`;
      await fs.writeFile(memoryPath, previousMemory);
      const notePath = h.path("memory", "2026-08-26.md");
      await fs.mkdir(path.dirname(notePath), { recursive: true });
      await fs.writeFile(notePath, `${snippet}\n`);
      await h.recordOrigins(
        [
          memoryOrigin("retired-entry", "private-session", {
            agentId: "gamma",
            sessionKey: "agent:gamma:private-session",
          }),
        ],
        "gamma",
      );
      const vacantDb = openOpenClawAgentDatabase({ agentId: "vacant" }).db;
      vacantDb.exec("DROP TABLE IF EXISTS memory_entry_origins");
      const nowMs = Date.parse("2026-08-26T12:00:00.000Z");
      const candidates = await candidatesFor(
        "memory/2026-08-26.md",
        snippet,
        nowMs,
        "alpha-session",
        "alpha",
        action === "superseded" ? "launch-code" : undefined,
      );

      const promoted = candidates[0];
      expect(promoted).toBeDefined();
      const promotedKey = promoted!.key;
      const promotedMarker = `openclaw-memory-promotion:${promotedKey}`;
      const output = JSON.stringify({
        operations: [{ candidateKey: promotedKey, action, priorEntries: [priorEntry] }],
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
        workspaceDir: h.workspaceDir,
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
        expect(memory).toContain(promotedMarker);
        expect(await origins("gamma", promotedKey)).toEqual([]);
        await forget({ sessionIds: ["private-session"] }, "gamma");
        expect(await readText(memoryPath)).toContain(promotedMarker);
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
          expect(await readText(memoryPath)).toContain(promotedMarker);
        } else {
          expect(await readText(memoryPath)).toBe(
            fileFailure === "rename-changed" ? externalMemory : previousMemory,
          );
        }
        expect(
          (await readShortTermRecallEntries({ workspaceDir: h.workspaceDir, nowMs }))[0]
            ?.promotedAt,
        ).toBeUndefined();
        expect((await readBackups()).map(({ value }) => value.content)).toEqual([previousMemory]);
        expect(await origins("gamma", "retired-entry")).toHaveLength(1);
        expect(await origins("gamma", promotedKey)).toMatchObject([
          { entryKey: promotedKey, sessionId: "private-session" },
        ]);
        const report = await forget({ sessionIds: ["private-session"] }, "gamma");
        expect(report.entryKeys).toContain(promotedKey);
        expect(await readText(memoryPath)).not.toContain(promotedMarker);
        expect(await origins("gamma", promotedKey)).toEqual([]);
        return;
      }
      if (failOrigins) {
        try {
          await expect(application).rejects.toThrow("injected origin write failure");
          await expect(readText(memoryPath)).resolves.toBe(previousMemory);
          expect(
            (await readShortTermRecallEntries({ workspaceDir: h.workspaceDir, nowMs }))[0]
              ?.promotedAt,
          ).toBeUndefined();
        } finally {
          restoreOriginFailure?.();
        }
        return;
      }
      const applied = await application;

      expect(applied.applied).toBe(1);
      expect(await origins("gamma", promotedKey)).toMatchObject([
        { entryKey: promotedKey, sessionId: "private-session" },
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
        entryKeys: expect.arrayContaining([promotedKey]),
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

  it("warns and preserves historical untraceable highlights in DREAMS.md", async () => {
    await h.seedSession("target");
    await h.recordOrigins([memoryOrigin("historical", "target")]);
    const diaryPath = h.path("DREAMS.md");
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
  });

  it("removes only the selected historical session highlight, not its following sibling", async () => {
    await h.seedSession("target");
    const diaryPath = h.path("DREAMS.md");
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
    await h.seedSession("target");
    const nowMs = Date.parse("2026-08-25T12:00:00.000Z");
    const snippet = "The undisclosed launch code is cobalt.";
    const sourcePath = "memory/2026-08-25.md";
    await fs.mkdir(h.path("memory"), { recursive: true });
    await h.write(sourcePath, `${snippet}\n`);
    await h.write(
      "MEMORY.md",
      "# Long-Term Memory\nCurated operator fact.\n\n## Promoted From Short-Term Memory (2026-08-24)\n<!-- openclaw-memory-promotion:older-entry -->\n- " +
        "x".repeat(500) +
        "\n",
    );
    const candidates = await candidatesFor(sourcePath, snippet, nowMs);

    const candidateKey = candidates[0]?.key;
    expect(candidateKey).toMatch(/^memory:claim:/);

    const promoted = await applyShortTermPromotions({
      agentId: "main",
      workspaceDir: h.workspaceDir,
      candidates,
      nowMs,
      memoryFileMaxChars: 450,
      maxPriorEntryLossFraction: 1,
      ...thresholds,
    });
    expect(promoted).toMatchObject({ appended: 1, compactedDates: ["2026-08-24"] });
    const promotedMemory = await h.read("MEMORY.md");
    expect(promotedMemory).toContain(`<!-- openclaw-memory-promotion:${candidateKey} -->`);
    expect(promotedMemory).toContain(snippet);

    const report = await forget({ sessionIds: ["target"] });

    expect(report).toMatchObject({
      entryKeys: [candidateKey],
      artifacts: { memoryFiles: 1, memoryEntries: 1, shortTermEntries: 1, originRows: 1 },
    });
    const survivingMemory = await h.read("MEMORY.md");
    expect(survivingMemory).toContain("Curated operator fact.");
    expect(survivingMemory).not.toContain(snippet);
    expect(survivingMemory).not.toContain(candidateKey);
  });
});

describe("memory forget curated writes", () => {
  const forget = (dryRun = false) => h.forget({ sessionIds: ["target"], dryRun });

  const toolCall = (id: string, name: string, args: unknown) => ({
    type: "toolCall",
    id,
    name,
    arguments: args,
  });

  it("reports session-authored curated memory without deleting unattributable file content", async () => {
    await h.seedSession("target");
    const curatedContent = "# Long-Term Memory\nThe launch code is violet.\n";
    const writeTool = createOpenClawCodingTools({
      workspaceDir: h.workspaceDir,
      config: h.cfg,
      sessionId: "target",
      sessionKey: "agent:main:target",
      senderIsOwner: true,
    }).find((tool) => tool.name === "write");
    expect(writeTool).toBeDefined();
    await writeTool!.execute("write-curated-memory", {
      path: "MEMORY.md",
      content: curatedContent,
    });
    await h.append("target", {
      role: "assistant",
      content: [toolCall("observed-write", "write", { path: "MEMORY.md" })],
    });

    const preview = await forget(true);
    expect(preview.curatedWrites).toEqual([
      { relativePath: "MEMORY.md", observedAt: expect.any(Number) },
    ]);
    expect(await h.read("MEMORY.md")).toBe(curatedContent);

    const report = await forget();
    expect(report).toEqual({ ...preview, dryRun: false });
    expect(report.artifacts.memoryFiles).toBe(0);
    expect(await h.read("MEMORY.md")).toBe(curatedContent);
  });

  it("reports harness memory writes from selected live and archived transcripts without observer state", async () => {
    await h.seedSession("survivor");
    await h.seedSession("target");
    const observedAt = Date.parse("2026-08-26T12:34:56.000Z");
    const memoryContent = "# Long-Term Memory\nA harness-authored private fact.\n";
    await fs.mkdir(h.path("memory"), { recursive: true });
    await h.write("MEMORY.md", memoryContent);
    await h.write("USER.md", "# User\n");
    await fs.writeFile(h.path("memory", "profile.md"), "# Profile\n");
    const patchInput = [
      "*** Begin Patch",
      "*** Update File: MEMORY.md",
      "@@",
      "+A harness-authored private fact.",
      "*** Update File: README.md",
      "@@",
      "+Not a memory file.",
      "*** End Patch",
    ].join("\n");
    await h.append("target", {
      role: "assistant",
      timestamp: observedAt,
      content: [
        toolCall("patch", "apply_patch", { input: patchInput }),
        toolCall("profile", "write", { path: "USER.md" }),
        {
          type: "toolCall",
          id: "nested",
          name: "edit",
          input: { file_path: h.path("memory", "profile.md") },
        },
        toolCall("structured", "apply_patch", {
          changes: [{ path: "memory/structured.md" }, { path: "README.md" }],
        }),
        toolCall("ordinary", "write", { path: "README.md" }),
        toolCall("escaping", "edit", { path: "../MEMORY.md" }),
        toolCall("malformed", "apply_patch", { input: 42 }),
        toolCall("read-only", "read", { path: "MEMORY.md" }),
        toolCall("missing", "write", null),
        null,
      ],
    });
    await h.append("survivor", {
      role: "assistant",
      timestamp: observedAt + 1,
      content: [toolCall("unselected", "write", { path: "memory/keep.md" })],
    });
    const archiveDir = path.join(h.stateDir, "agents", "main", "sessions");
    await fs.mkdir(archiveDir, { recursive: true });
    const archivedMessage = {
      type: "message",
      timestamp: new Date(observedAt + 1).toISOString(),
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "archived",
            name: "edit",
            input: { filePath: "memory/archive.md" },
          },
        ],
      },
    };
    await fs.writeFile(
      path.join(archiveDir, "target.jsonl.deleted.2026-08-26T12-35-00.000Z.zst"),
      zstdCompressSync(`${JSON.stringify(archivedMessage)}\n`),
    );
    expect(await listMemoryArtifactProvenance({ workspaceDir: h.workspaceDir })).toEqual([]);

    const preview = await forget(true);

    expect(preview.curatedWrites).toEqual([
      { relativePath: "MEMORY.md", observedAt },
      { relativePath: "memory/archive.md", observedAt: observedAt + 1 },
      { relativePath: "memory/profile.md", observedAt },
      { relativePath: "memory/structured.md", observedAt },
      { relativePath: "USER.md", observedAt },
    ]);
    expect(await h.read("MEMORY.md")).toBe(memoryContent);

    const report = await forget();
    expect(report).toEqual({ ...preview, dryRun: false });
    expect(report.artifacts.memoryFiles).toBe(0);
    expect(await h.read("MEMORY.md")).toBe(memoryContent);
  });
});
