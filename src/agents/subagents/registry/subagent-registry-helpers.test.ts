import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { defaultRuntime } from "../../../runtime.js";
import {
  createSubagentRunRecord,
  type SubagentRunRecordOverrides,
} from "../../subagent-test-fixtures.test-helpers.js";
import { resolveSubagentSessionAttachmentRootDir } from "../subagent-attachment-paths.js";
import { updateSwarmCollectorCompletion } from "../swarm/swarm-collector.js";
import {
  capFrozenResultText,
  logAnnounceGiveUp,
  resolveAnnounceRetryDelayMs,
  safeRemoveAttachmentsDir,
  updateSubagentArchiveAtMs,
} from "./subagent-registry-helpers.js";
function createRunEntry(overrides: Omit<SubagentRunRecordOverrides, "runId"> = {}) {
  return createSubagentRunRecord({
    runId: "run-1",
    task: "finish the task",
    retainAttachmentsOnKeep: true,
    createdAt: 500,
    startedAt: 1_000,
    ...overrides,
  });
}

it("preserves the zero-jitter retry schedule through attempt 10", () => {
  const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);

  expect(Array.from({ length: 10 }, (_, index) => resolveAnnounceRetryDelayMs(index + 1))).toEqual([
    15_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000, 300_000, 300_000,
  ]);
  randomSpy.mockRestore();
});

it("preserves a valid UTF-8 prefix within the frozen-result byte budget", () => {
  const result = capFrozenResultText("😀".repeat(25_601));

  expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(100 * 1024);
  expect(result).not.toContain("�");
  expect(result).toContain("[truncated: frozen completion output exceeded 100KB");
});

describe("updateSubagentArchiveAtMs", () => {
  const cfg = { agents: { defaults: { subagents: { archiveAfterMinutes: 5 } } } };

  it("starts retention when a delayed result first becomes waitable", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const entry = createRunEntry({
      collect: true,
      endedAt: 2_000,
      outcome: { status: "ok" },
      completion: { required: false, resultText: "done" },
    });

    expect(updateSwarmCollectorCompletion(entry, cfg, { entry: undefined })).toBe(true);
    expect(entry).toMatchObject({ completion: { capturedAt: 10_000 }, archiveAtMs: 310_000 });
    vi.useRealTimers();
  });

  it("clears stale deadlines from active, paused, persistent, and retained runs", () => {
    for (const overrides of [
      { cleanup: "delete" as const },
      { collect: true },
      { cleanup: "delete" as const, pauseReason: "sessions_yield" as const, endedAt: 2_000 },
      { cleanup: "keep" as const, endedAt: 2_000 },
      { collect: true, spawnMode: "session" as const, endedAt: 2_000 },
    ]) {
      const entry = createRunEntry({ ...overrides, archiveAtMs: 10_000 });
      expect(updateSubagentArchiveAtMs(entry, cfg)).toBe(true);
      expect(entry.archiveAtMs).toBeUndefined();
    }
  });

  it("never arms retention when archiveAfterMinutes is zero", () => {
    for (const collect of [false, true]) {
      const entry = createRunEntry({
        cleanup: "delete",
        collect,
        endedAt: 2_000,
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
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  afterEach(() => vi.unstubAllEnvs());

  it("records cleanup failures even when callers do not inspect the result", async () => {
    using log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    await expect(
      safeRemoveAttachmentsDir(createRunEntry({ attachmentId: "invalid" })),
    ).resolves.toBe(false);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        "Subagent attachment cleanup failed (run-1): Error: invalid subagent attachment identity",
      ),
    );
  });

  it("removes only the generated directory under the host-owned root", async () => {
    const stateDir = tempDirs.make("openclaw-attachment-state-");
    const attachmentId = "2d4a8398-4d5a-4c20-9c16-0a5f6627cf92";
    const childSessionKey = "agent:main:subagent:child";
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const attachmentDir = path.join(
      resolveSubagentSessionAttachmentRootDir({
        agentId: "main",
        childSessionKey,
      }),
      attachmentId,
    );
    const siblingDir = path.join(stateDir, "attachments", "subagents", "main", "sibling");
    await fs.mkdir(attachmentDir, { recursive: true });
    await fs.mkdir(siblingDir, { recursive: true });
    await fs.writeFile(path.join(attachmentDir, "staged.txt"), "staged");

    await expect(
      safeRemoveAttachmentsDir(createRunEntry({ attachmentId, childSessionKey })),
    ).resolves.toBe(true);
    await expect(fs.access(attachmentDir)).rejects.toHaveProperty("code", "ENOENT");
    await expect(
      safeRemoveAttachmentsDir(createRunEntry({ attachmentId, childSessionKey })),
    ).resolves.toBe(true);
    await fs.access(siblingDir);
  });

  it("ignores legacy workspace paths through an external symlink", async () => {
    const workspaceDir = tempDirs.make("openclaw-attachment-root-");
    const externalDir = tempDirs.make("openclaw-attachment-external-");
    const relDir = ".openclaw/attachments/run-1";
    const externalSentinel = path.join(externalDir, "sentinel.txt");
    await fs.mkdir(path.join(workspaceDir, ".openclaw"));
    await fs.writeFile(externalSentinel, "must-survive");
    await fs.symlink(externalDir, path.join(workspaceDir, ".openclaw", "attachments"));

    await expect(
      safeRemoveAttachmentsDir(
        createRunEntry({ attachmentsRootDir: workspaceDir, attachmentsDir: relDir }),
      ),
    ).resolves.toBe(true);
    await expect(fs.readFile(externalSentinel, "utf8")).resolves.toBe("must-survive");
    await expect(fs.readdir(externalDir)).resolves.toEqual(["sentinel.txt"]);
  });
});

describe("logAnnounceGiveUp", () => {
  it.each([
    [
      "gateway timeout\nphase: routed dispatch failed",
      'deliveryError="gateway timeout phase: routed dispatch failed"',
      "\n",
    ],
    [`${"x".repeat(1_999)}🚀tail`, `${"x".repeat(1_999)}…`, "\uD83D"],
  ])(
    "keeps delivery errors bounded and on one well-formed log line (%s)",
    (lastError, included, excluded) => {
      using log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
      logAnnounceGiveUp(createRunEntry({ delivery: { status: "failed", lastError } }), "expiry");
      expect(log).toHaveBeenCalledWith(expect.stringContaining(included));
      expect(String(log.mock.calls[0]?.[0])).not.toContain(excluded);
    },
  );
});
