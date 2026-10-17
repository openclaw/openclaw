import fs from "node:fs/promises";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { createOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { listSessionTranscriptCorpusEntriesForAgent } from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import { listMemoryArtifactProvenance } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forgetMemoryEntries } from "./memory-forget.js";
import { createMemoryForgetFixture } from "./memory-forget.test-helpers.js";

describe("memory forget curated writes", () => {
  const forget = (dryRun = false) =>
    forgetMemoryEntries({ cfg, agentId: "main", sessionIds: ["target"], dryRun });
  const readText = (file: string) => fs.readFile(file, "utf8");
  let fixture: Awaited<ReturnType<typeof createMemoryForgetFixture>>;
  let stateDir: string;
  let workspaceDir: string;
  let cfg: OpenClawConfig;

  beforeEach(async () => {
    fixture = await createMemoryForgetFixture("memory-forget-curated-writes-");
    ({ stateDir, workspaceDir, cfg } = fixture);
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  const toolCall = (id: string, name: string, args: unknown) => ({
    type: "toolCall",
    id,
    name,
    arguments: args,
  });

  const append = (
    sessionId: string,
    message: Parameters<typeof appendSessionTranscriptMessageByIdentity>[0]["message"],
  ) =>
    appendSessionTranscriptMessageByIdentity({
      agentId: "main",
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
      message,
    });

  async function seedSession(sessionId: string): Promise<void> {
    await upsertSessionEntry({
      agentId: "main",
      sessionKey: `agent:main:${sessionId}`,
      entry: { sessionId, updatedAt: 1_000 },
    });
  }

  it("reports session-authored curated memory without deleting unattributable file content", async () => {
    await seedSession("target");
    const curatedContent = "# Long-Term Memory\nThe launch code is violet.\n";
    const writeTool = createOpenClawCodingTools({
      workspaceDir,
      config: cfg,
      sessionId: "target",
      sessionKey: "agent:main:target",
      senderIsOwner: true,
    }).find((tool) => tool.name === "write");
    expect(writeTool).toBeDefined();
    await writeTool!.execute("write-curated-memory", {
      path: "MEMORY.md",
      content: curatedContent,
    });
    await append("target", {
      role: "assistant",
      content: [toolCall("observed-write", "write", { path: "MEMORY.md" })],
    });

    const preview = await forget(true);
    expect(preview.curatedWrites).toEqual([
      { relativePath: "MEMORY.md", observedAt: expect.any(Number) },
    ]);
    expect(await readText(path.join(workspaceDir, "MEMORY.md"))).toBe(curatedContent);

    const report = await forget();
    expect(report).toEqual({ ...preview, dryRun: false });
    expect(report.artifacts.memoryFiles).toBe(0);
    expect(await readText(path.join(workspaceDir, "MEMORY.md"))).toBe(curatedContent);
  });

  it("reports harness memory writes from selected live and archived transcripts without observer state", async () => {
    await seedSession("survivor");
    await seedSession("target");
    const observedAt = Date.parse("2026-08-26T12:34:56.000Z");
    const memoryContent = "# Long-Term Memory\nA harness-authored private fact.\n";
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), memoryContent);
    await fs.writeFile(path.join(workspaceDir, "USER.md"), "# User\n");
    await fs.writeFile(path.join(workspaceDir, "memory", "profile.md"), "# Profile\n");
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
    await append("target", {
      role: "assistant",
      timestamp: observedAt,
      content: [
        toolCall("patch", "apply_patch", { input: patchInput }),
        toolCall("profile", "write", { path: "USER.md" }),
        {
          type: "toolCall",
          id: "nested",
          name: "edit",
          input: { file_path: path.join(workspaceDir, "memory", "profile.md") },
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
    await append("survivor", {
      role: "assistant",
      timestamp: observedAt + 1,
      content: [toolCall("unselected", "write", { path: "memory/keep.md" })],
    });
    const archiveDir = path.join(stateDir, "agents", "main", "sessions");
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
    expect(await listSessionTranscriptCorpusEntriesForAgent("main")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: "target", artifactKind: "active-session" }),
        expect.objectContaining({ sessionId: "target", artifactKind: "archive-artifact" }),
      ]),
    );
    expect(await listMemoryArtifactProvenance({ workspaceDir })).toEqual([]);

    const preview = await forget(true);

    expect(preview.curatedWrites).toEqual([
      { relativePath: "MEMORY.md", observedAt },
      { relativePath: "memory/archive.md", observedAt: observedAt + 1 },
      { relativePath: "memory/profile.md", observedAt },
      { relativePath: "memory/structured.md", observedAt },
      { relativePath: "USER.md", observedAt },
    ]);
    expect(await readText(path.join(workspaceDir, "MEMORY.md"))).toBe(memoryContent);

    const report = await forget();
    expect(report).toEqual({ ...preview, dryRun: false });
    expect(report.artifacts.memoryFiles).toBe(0);
    expect(await readText(path.join(workspaceDir, "MEMORY.md"))).toBe(memoryContent);
  });
});
