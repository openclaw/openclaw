import fs from "node:fs/promises";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { createOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import { listSessionTranscriptCorpusEntriesForAgent } from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import { listMemoryArtifactProvenance } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { describe, expect, it } from "vitest";
import { memoryForgetHarness } from "./memory-forget.suite.test-support.js";

describe("memory forget curated writes", () => {
  const h = memoryForgetHarness();
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
    expect(await listSessionTranscriptCorpusEntriesForAgent("main")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: "target", artifactKind: "active-session" }),
        expect.objectContaining({ sessionId: "target", artifactKind: "archive-artifact" }),
      ]),
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
