import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyMemoryAuditSuggestion,
  collectMemoryAuditContext,
  readMemoryAuditSuggestions,
  rejectMemoryAuditSuggestion,
  stageMemoryAuditSuggestions,
} from "./memory-audit.js";

let tmpDir: string;

function config(workspaceDir = tmpDir): OpenClawConfig {
  return {
    agents: {
      list: [{ id: "main", default: true, workspace: workspaceDir }],
    },
  } as OpenClawConfig;
}

async function writeMemoryFile(relPath: string, content: string): Promise<void> {
  const filePath = path.join(tmpDir, relPath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

describe("memory audit", () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-audit-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("collects durable memory surfaces and paragraph blocks", async () => {
    await writeMemoryFile("MEMORY.md", "Useful preference.\n\nTemporary scratch note.\n");
    await writeMemoryFile("USER.md", "User profile fact.\n");
    await writeMemoryFile("TOOLS.md", "Tool usage fact.\n");
    await writeMemoryFile("shared-memory.md", "Shared fact.\n");

    const result = await collectMemoryAuditContext({ cfg: config(), limit: 10 });

    expect(result.surfaces.map((surface) => surface.path).sort()).toEqual([
      "MEMORY.md",
      "TOOLS.md",
      "USER.md",
      "shared-memory.md",
    ]);
    expect(result.blocks.map((block) => block.text)).toContain("Useful preference.");
    expect(result.blocks.map((block) => block.text)).toContain("Temporary scratch note.");
    expect(result.pendingSuggestions).toBe(0);
  });

  it("stages recommendations without editing memory files", async () => {
    await writeMemoryFile("MEMORY.md", "Keep this.\n\nJunk note.\n");
    const collected = await collectMemoryAuditContext({ cfg: config(), limit: 10 });
    const junk = collected.blocks.find((block) => block.text === "Junk note.");
    expect(junk).toBeTruthy();

    const summary = await stageMemoryAuditSuggestions({
      cfg: config(),
      reviewerAgentId: "auditor",
      suggestions: [
        {
          action: "delete",
          rationale: "Scratch note is not durable memory.",
          source: {
            surfaceId: junk!.surface.id,
            startLine: junk!.startLine,
            endLine: junk!.endLine,
            hash: junk!.hash,
          },
        },
      ],
      nowMs: Date.parse("2026-05-23T00:00:00.000Z"),
    });

    expect(summary.pending).toBe(1);
    await expect(fs.readFile(path.join(tmpDir, "MEMORY.md"), "utf8")).resolves.toBe(
      "Keep this.\n\nJunk note.\n",
    );
  });

  it("applies and rejects pending recommendations through explicit actions", async () => {
    await writeMemoryFile("MEMORY.md", "Keep this.\n\nJunk note.\n");
    const collected = await collectMemoryAuditContext({ cfg: config(), limit: 10 });
    const junk = collected.blocks.find((block) => block.text === "Junk note.");
    expect(junk).toBeTruthy();
    await stageMemoryAuditSuggestions({
      cfg: config(),
      suggestions: [
        {
          action: "delete",
          source: {
            surfaceId: junk!.surface.id,
            startLine: junk!.startLine,
            endLine: junk!.endLine,
            hash: junk!.hash,
          },
        },
        {
          action: "add",
          text: "Durable new fact.",
          target: {
            surfaceId: collected.surfaces.find((surface) => surface.path === "USER.md")?.id,
          },
        },
      ],
    });
    const staged = await readMemoryAuditSuggestions({ workspaceDir: tmpDir });
    const deletion = staged.suggestions.find((entry) => entry.action === "delete");
    const addition = staged.suggestions.find((entry) => entry.action === "add");
    expect(deletion).toBeTruthy();
    expect(addition).toBeTruthy();

    await applyMemoryAuditSuggestion({ workspaceDir: tmpDir, id: deletion!.id });
    await rejectMemoryAuditSuggestion({ workspaceDir: tmpDir, id: addition!.id });

    await expect(fs.readFile(path.join(tmpDir, "MEMORY.md"), "utf8")).resolves.toBe("Keep this.\n");
    const summary = await readMemoryAuditSuggestions({ workspaceDir: tmpDir });
    expect(summary.applied).toBe(1);
    expect(summary.rejected).toBe(1);
    expect(summary.pending).toBe(0);
  });
});
