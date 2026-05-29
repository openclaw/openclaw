import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

async function writeSessionLog(params: {
  agentId?: string;
  sessionId: string;
  updatedAt: number;
  lines: string[];
}): Promise<void> {
  const agentId = params.agentId ?? "main";
  const sessionsDir = path.join(tmpDir, "state", "agents", agentId, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.writeFile(
    path.join(sessionsDir, `${params.sessionId}.jsonl`),
    params.lines.join("\n"),
    "utf8",
  );
  await fs.writeFile(
    path.join(sessionsDir, "sessions.json"),
    JSON.stringify({
      [`agent:${agentId}:${params.sessionId}`]: {
        sessionId: params.sessionId,
        updatedAt: params.updatedAt,
        sessionFile: `${params.sessionId}.jsonl`,
      },
    }),
    "utf8",
  );
}

describe("memory audit", () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-audit-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(tmpDir, "state"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("collects writable targets and paragraph blocks", async () => {
    await writeMemoryFile("AGENTS.md", "Agent operating rule.\n");
    await writeMemoryFile("MEMORY.md", "Useful preference.\n\nTemporary scratch note.\n");
    await writeMemoryFile("USER.md", "User profile fact.\n");
    await writeMemoryFile("TOOLS.md", "Tool usage fact.\n");
    await writeMemoryFile("shared-memory.md", "Shared fact.\n");

    const result = await collectMemoryAuditContext({ cfg: config(), limit: 10 });

    expect(result.surfaces.map((surface) => surface.path).sort()).toEqual([
      "AGENTS.md",
      "MEMORY.md",
      "TOOLS.md",
      "USER.md",
      "shared-memory.md",
    ]);
    expect(result.surfaces.every((surface) => surface.writable)).toBe(true);
    expect(result.blocks.map((block) => block.text)).toContain("Agent operating rule.");
    expect(result.blocks.map((block) => block.text)).toContain("Useful preference.");
    expect(result.blocks.map((block) => block.text)).toContain("Temporary scratch note.");
    expect(result.pendingSuggestions).toBe(0);
  });

  it("collects daily memory and session logs as read-only evidence", async () => {
    await writeMemoryFile("MEMORY.md", "Durable fact.\n");
    await writeMemoryFile("memory/2026-05-01.md", "Daily observation.\n");
    await writeMemoryFile(
      "memory/dreaming/2026-05-01.md",
      "Dream report should not be direct daily evidence.\n",
    );
    await writeSessionLog({
      sessionId: "thread-1",
      updatedAt: Date.parse("2026-05-02T00:00:00.000Z"),
      lines: [
        JSON.stringify({ type: "header" }),
        JSON.stringify({
          message: { role: "user", content: [{ type: "text", text: "Session fact." }] },
        }),
      ],
    });

    const result = await collectMemoryAuditContext({ cfg: config(), limit: 20 });

    const daily = result.surfaces.find((surface) => surface.path === "memory/2026-05-01.md");
    const session = result.surfaces.find((surface) => surface.kind === "session-log");
    expect(daily).toMatchObject({ kind: "daily-memory", writable: false });
    expect(session).toMatchObject({ kind: "session-log", writable: false, agentId: "main" });
    expect(result.surfaces.some((surface) => surface.path.includes("memory/dreaming/"))).toBe(
      false,
    );
    expect(result.blocks.map((block) => block.text)).toContain("Daily observation.");
    expect(result.blocks.map((block) => block.text)).toContain("Session fact.");
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

  it("promotes session evidence into writable targets without editing the transcript", async () => {
    await writeMemoryFile("AGENTS.md", "Existing rule.\n");
    await writeSessionLog({
      sessionId: "thread-1",
      updatedAt: Date.parse("2026-05-02T00:00:00.000Z"),
      lines: [
        JSON.stringify({
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Always verify cron reconciliation after restart." }],
          },
        }),
      ],
    });
    const collected = await collectMemoryAuditContext({ cfg: config(), limit: 20 });
    const sessionBlock = collected.blocks.find((block) => block.surface.kind === "session-log");
    const agents = collected.surfaces.find((surface) => surface.path === "AGENTS.md");
    expect(sessionBlock).toBeTruthy();
    expect(agents).toBeTruthy();

    const summary = await stageMemoryAuditSuggestions({
      cfg: config(),
      suggestions: [
        {
          action: "add",
          text: "Verify cron reconciliation after restart.",
          source: {
            surfaceId: sessionBlock!.surface.id,
            startLine: sessionBlock!.startLine,
            endLine: sessionBlock!.endLine,
            hash: sessionBlock!.hash,
          },
          target: {
            surfaceId: agents!.id,
          },
        },
      ],
    });
    const suggestion = summary.suggestions.find((entry) => entry.action === "add");
    expect(suggestion).toBeTruthy();

    await applyMemoryAuditSuggestion({ workspaceDir: tmpDir, id: suggestion!.id });

    await expect(fs.readFile(path.join(tmpDir, "AGENTS.md"), "utf8")).resolves.toContain(
      "Verify cron reconciliation after restart.",
    );
    await expect(
      fs.readFile(
        path.join(tmpDir, "state", "agents", "main", "sessions", "thread-1.jsonl"),
        "utf8",
      ),
    ).resolves.toContain("Always verify cron reconciliation after restart.");
  });

  it("rejects mutations against read-only evidence surfaces", async () => {
    await writeMemoryFile("MEMORY.md", "Durable fact.\n");
    await writeMemoryFile("memory/2026-05-01.md", "Daily observation.\n");
    const collected = await collectMemoryAuditContext({ cfg: config(), limit: 20 });
    const dailyBlock = collected.blocks.find((block) => block.surface.kind === "daily-memory");
    expect(dailyBlock).toBeTruthy();

    await expect(
      stageMemoryAuditSuggestions({
        cfg: config(),
        suggestions: [
          {
            action: "delete",
            source: {
              surfaceId: dailyBlock!.surface.id,
              startLine: dailyBlock!.startLine,
              endLine: dailyBlock!.endLine,
              hash: dailyBlock!.hash,
            },
          },
        ],
      }),
    ).rejects.toThrow("read-only evidence surfaces");

    await expect(
      stageMemoryAuditSuggestions({
        cfg: config(),
        suggestions: [
          {
            action: "add",
            text: "Do not target daily files.",
            target: {
              surfaceId: dailyBlock!.surface.id,
            },
          },
        ],
      }),
    ).rejects.toThrow("writable memory surface");
  });
});
