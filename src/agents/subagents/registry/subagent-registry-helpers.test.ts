// Subagent registry helper tests cover attachment cleanup and compact logging
// for announce delivery give-up paths.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultRuntime } from "../../../runtime.js";
import { resolveSubagentAttachmentDir } from "../subagent-attachment-paths.js";
import { updateSwarmCollectorCompletion } from "../swarm/swarm-collector.js";
import {
  capFrozenResultText,
  logAnnounceGiveUp,
  resolveAnnounceRetryDelayMs,
  safeRemoveAttachmentsDir,
  updateSubagentArchiveAtMs,
} from "./subagent-registry-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function createRunEntry(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: "run-1",
    childSessionKey: "agent:main:subagent:child",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "finish the task",
    cleanup: "keep",
    retainAttachmentsOnKeep: true,
    createdAt: 500,
    execution: { status: "running", startedAt: 1_000 },
    ...overrides,
  };
}

describe("resolveAnnounceRetryDelayMs", () => {
  it("preserves the zero-jitter retry schedule through attempt 10", () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);

    expect(
      Array.from({ length: 10 }, (_, index) => resolveAnnounceRetryDelayMs(index + 1)),
    ).toEqual([
      15_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000, 300_000, 300_000,
    ]);
    randomSpy.mockRestore();
  });

  it("applies positive jitter without exceeding the five-minute cap", () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(1);

    expect(resolveAnnounceRetryDelayMs(1)).toBe(18_000);
    expect(resolveAnnounceRetryDelayMs(6)).toBe(300_000);
    randomSpy.mockRestore();
  });
});

describe("capFrozenResultText", () => {
  it("preserves a valid UTF-8 prefix within the frozen-result byte budget", () => {
    const result = capFrozenResultText("😀".repeat(25_601));

    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(100 * 1024);
    expect(result).not.toContain("�");
    expect(result).toContain("[truncated: frozen completion output exceeded 100KB");
  });
});

describe("updateSubagentArchiveAtMs", () => {
  const cfg = { agents: { defaults: { subagents: { archiveAfterMinutes: 5 } } } };

  it("defers delete-mode and collector retention until terminal completion", () => {
    for (const overrides of [
      { cleanup: "delete" as const },
      { cleanup: "keep" as const, collect: true },
      { cleanup: "delete" as const, collect: true },
    ]) {
      const entry = createRunEntry(overrides);
      expect(updateSubagentArchiveAtMs(entry, cfg)).toBe(false);
      expect(entry.archiveAtMs).toBeUndefined();
    }
  });

  it("starts ordinary delete-mode retention at execution completion", () => {
    const entry = createRunEntry({
      cleanup: "delete",
      createdAt: 500,
      execution: { status: "terminal", startedAt: 1_000, endedAt: 602_000 },
      archiveAtMs: 300_500,
    });

    expect(updateSubagentArchiveAtMs(entry, cfg)).toBe(true);
    expect(entry.archiveAtMs).toBe(902_000);
    expect(updateSubagentArchiveAtMs(entry, cfg)).toBe(false);
  });

  it("starts collector retention when terminal completion is frozen", () => {
    const entry = createRunEntry({
      collect: true,
      execution: {
        status: "terminal",
        startedAt: 1_000,
        endedAt: 2_000,
        outcome: { status: "ok" },
      },
      completion: { required: false, resultText: "done", capturedAt: 2_000 },
    });

    expect(updateSwarmCollectorCompletion(entry, cfg)).toBe(true);
    expect(entry.collectorCompletion).toEqual({ status: "done" });
    expect(entry.archiveAtMs).toBe(302_000);
  });

  it("starts retention when a delayed result first becomes waitable", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const entry = createRunEntry({
      collect: true,
      execution: {
        status: "terminal",
        startedAt: 1_000,
        endedAt: 2_000,
        outcome: { status: "ok" },
      },
      completion: { required: false, resultText: "done" },
    });

    expect(updateSwarmCollectorCompletion(entry, cfg)).toBe(true);
    expect(entry.completion?.capturedAt).toBe(10_000);
    expect(entry.archiveAtMs).toBe(310_000);
    vi.useRealTimers();
  });

  it("backfills legacy collectors from their terminal time", () => {
    const entry = createRunEntry({
      collect: true,
      execution: { status: "terminal", startedAt: 1_000, endedAt: 2_000 },
      archiveAtMs: 10_000,
    });

    expect(updateSubagentArchiveAtMs(entry, cfg)).toBe(true);
    expect(entry.archiveAtMs).toBe(302_000);
    expect(updateSubagentArchiveAtMs(entry, cfg)).toBe(false);
  });

  it("clears stale deadlines from active, paused, persistent, and retained runs", () => {
    for (const overrides of [
      { cleanup: "delete" as const },
      { collect: true },
      {
        cleanup: "delete" as const,
        pauseReason: "sessions_yield" as const,
        execution: { status: "terminal" as const, startedAt: 1_000, endedAt: 2_000 },
      },
      {
        cleanup: "keep" as const,
        execution: { status: "terminal" as const, startedAt: 1_000, endedAt: 2_000 },
      },
    ]) {
      const entry = createRunEntry({ ...overrides, archiveAtMs: 10_000 });
      expect(updateSubagentArchiveAtMs(entry, cfg)).toBe(true);
      expect(entry.archiveAtMs).toBeUndefined();
    }

    const persistent = createRunEntry({
      collect: true,
      spawnMode: "session",
      execution: { status: "terminal", startedAt: 1_000, endedAt: 2_000 },
      archiveAtMs: 10_000,
    });
    expect(updateSubagentArchiveAtMs(persistent, cfg)).toBe(true);
    expect(persistent.archiveAtMs).toBeUndefined();
  });

  it("never arms retention when archiveAfterMinutes is zero", () => {
    for (const collect of [false, true]) {
      const entry = createRunEntry({
        cleanup: "delete",
        collect,
        execution: { status: "terminal", startedAt: 1_000, endedAt: 2_000 },
        archiveAtMs: 10_000,
      });

      expect(
        updateSubagentArchiveAtMs(entry, {
          agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
        }),
      ).toBe(true);
      expect(entry.archiveAtMs).toBeUndefined();
    }
  });
});

describe("safeRemoveAttachmentsDir", () => {
  it("removes only the generated directory under the host-owned root", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-attachment-state-"));
    const attachmentId = "2d4a8398-4d5a-4c20-9c16-0a5f6627cf92";
    const childSessionKey = "agent:main:subagent:child";
    const attachmentDir = resolveSubagentAttachmentDir("main", childSessionKey, attachmentId, {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
    });
    const siblingDir = path.join(stateDir, "attachments", "subagents", "main", "sibling");
    await fs.mkdir(attachmentDir, { recursive: true });
    await fs.mkdir(siblingDir, { recursive: true });
    await fs.writeFile(path.join(attachmentDir, "staged.txt"), "staged");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    await expect(
      safeRemoveAttachmentsDir(createRunEntry({ attachmentId, childSessionKey })),
    ).resolves.toBe(true);
    await expect(fs.access(attachmentDir)).rejects.toHaveProperty("code", "ENOENT");
    await expect(
      safeRemoveAttachmentsDir(createRunEntry({ attachmentId, childSessionKey })),
    ).resolves.toBe(true);
    await expect(fs.access(siblingDir)).resolves.toBeUndefined();

    vi.unstubAllEnvs();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("ignores legacy workspace paths after an external symlink replacement", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-attachment-root-"));
    const externalDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-attachment-external-"));
    const relDir = ".openclaw/attachments/run-1";
    const externalSentinel = path.join(externalDir, "sentinel.txt");
    await fs.mkdir(path.join(workspaceDir, ".openclaw", "attachments"), { recursive: true });
    await fs.mkdir(path.join(workspaceDir, relDir));
    await fs.writeFile(path.join(workspaceDir, relDir, "staged.txt"), "staged");
    await fs.writeFile(externalSentinel, "must-survive");
    await fs.rm(path.join(workspaceDir, ".openclaw", "attachments"), { recursive: true });
    await fs.symlink(externalDir, path.join(workspaceDir, ".openclaw", "attachments"));

    await expect(
      safeRemoveAttachmentsDir(
        createRunEntry({ attachmentsRootDir: workspaceDir, attachmentsDir: relDir }),
      ),
    ).resolves.toBe(true);
    await expect(fs.readFile(externalSentinel, "utf8")).resolves.toBe("must-survive");
    await expect(fs.readdir(externalDir)).resolves.toEqual(["sentinel.txt"]);

    await fs.rm(workspaceDir, { recursive: true, force: true });
    await fs.rm(externalDir, { recursive: true, force: true });
  });
});

describe("logAnnounceGiveUp", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("normalizes multiline delivery errors onto one gateway log line", () => {
    // Gateway logs are line-oriented; multiline provider errors must be
    // collapsed before they enter warning text.
    const logSpy = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const entry = createRunEntry({
      delivery: {
        status: "failed",
        lastError: "gateway timeout\nphase: routed dispatch failed",
      },
    });

    logAnnounceGiveUp(entry, "expiry");

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('deliveryError="gateway timeout phase: routed dispatch failed"'),
    );
    logSpy.mockRestore();
  });

  it("keeps bounded delivery errors UTF-16 well-formed", () => {
    const logSpy = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const entry = createRunEntry({
      delivery: {
        status: "failed",
        lastError: `${"x".repeat(1_999)}🚀tail`,
      },
    });

    logAnnounceGiveUp(entry, "expiry");

    const line = String(logSpy.mock.calls[0]?.[0]);
    expect(line).toContain(`${"x".repeat(1_999)}…`);
    expect(line).not.toContain("\uD83D");
    logSpy.mockRestore();
  });
});
