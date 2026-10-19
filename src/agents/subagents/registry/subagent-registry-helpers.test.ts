import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { defaultRuntime } from "../../../runtime.js";
import { resolveSubagentSessionAttachmentRootDir } from "../subagent-attachment-paths.js";
import { updateSwarmCollectorCompletion } from "../swarm/swarm-collector.js";
import {
  capFrozenResultText,
  logAnnounceGiveUp,
  resolveAnnounceRetryDelayMs,
  safeRemoveAttachmentsDir,
  updateSubagentArchiveAtMs,
} from "./subagent-registry-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const terminal = { status: "terminal", startedAt: 1_000, endedAt: 2_000 } as const;
const archiveConfig = (archiveAfterMinutes: number) => ({
  agents: { defaults: { subagents: { archiveAfterMinutes } } },
});
const childSessionKey = "agent:main:subagent:child";

function captureLog() {
  const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  onTestFinished(() => log.mockRestore());
  return log;
}

function createRunEntry(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: "run-1",
    childSessionKey,
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

it("starts retention when a delayed result first becomes waitable", () => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  const entry = createRunEntry({
    collect: true,
    execution: { ...terminal, outcome: { status: "ok" } },
    completion: { required: false, resultText: "done" },
  });

  expect(updateSwarmCollectorCompletion(entry, archiveConfig(5), { entry: undefined })).toBe(true);
  expect(entry.completion?.capturedAt).toBe(10_000);
  expect(entry.archiveAtMs).toBe(310_000);
  vi.useRealTimers();
});

it.each([
  ["active", { cleanup: "delete" }, 5],
  ["collecting", { collect: true }, 5],
  ["paused", { cleanup: "delete", pauseReason: "sessions_yield", execution: terminal }, 5],
  ["retained", { cleanup: "keep", execution: terminal }, 5],
  ["persistent", { collect: true, spawnMode: "session", execution: terminal }, 5],
  ["disabled", { cleanup: "delete", collect: false, execution: terminal }, 0],
  ["disabled collector", { cleanup: "delete", collect: true, execution: terminal }, 0],
] satisfies Array<[string, Partial<SubagentRunRecord>, number]>)(
  "clears the stale archive deadline for %s runs",
  (_name, overrides, minutes) => {
    const entry = createRunEntry({ ...overrides, archiveAtMs: 10_000 });
    expect(updateSubagentArchiveAtMs(entry, archiveConfig(minutes))).toBe(true);
    expect(entry.archiveAtMs).toBeUndefined();
  },
);

it("records cleanup failures even when callers do not inspect the result", async () => {
  const log = captureLog();
  await expect(safeRemoveAttachmentsDir(createRunEntry({ attachmentId: "invalid" }))).resolves.toBe(
    false,
  );
  expect(log).toHaveBeenCalledWith(
    expect.stringContaining(
      "Subagent attachment cleanup failed (run-1): Error: invalid subagent attachment identity",
    ),
  );
});

it("removes only the generated directory under the host-owned root", async () => {
  const stateDir = tempDirs.make("openclaw-attachment-state-");
  const attachmentId = "2d4a8398-4d5a-4c20-9c16-0a5f6627cf92";
  const attachmentDir = path.join(
    resolveSubagentSessionAttachmentRootDir({
      agentId: "main",
      childSessionKey,
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    }),
    attachmentId,
  );
  const siblingDir = path.join(stateDir, "attachments", "subagents", "main", "sibling");
  await fs.mkdir(attachmentDir, { recursive: true });
  await fs.mkdir(siblingDir, { recursive: true });
  await fs.writeFile(path.join(attachmentDir, "staged.txt"), "staged");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  onTestFinished(() => vi.unstubAllEnvs());

  await expect(
    safeRemoveAttachmentsDir(createRunEntry({ attachmentId, childSessionKey })),
  ).resolves.toBe(true);
  await expect(fs.access(attachmentDir)).rejects.toHaveProperty("code", "ENOENT");
  await expect(
    safeRemoveAttachmentsDir(createRunEntry({ attachmentId, childSessionKey })),
  ).resolves.toBe(true);
  await fs.access(siblingDir);
});

it("ignores legacy workspace paths after an external symlink replacement", async () => {
  const workspaceDir = tempDirs.make("openclaw-attachment-root-");
  const externalDir = tempDirs.make("openclaw-attachment-external-");
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
});

it.each([
  {
    name: "multiline",
    error: "gateway timeout\nphase: routed dispatch failed",
    expected: 'deliveryError="gateway timeout phase: routed dispatch failed"',
    excluded: "\n",
  },
  {
    name: "UTF-16",
    error: `${"x".repeat(1_999)}🚀tail`,
    expected: `${"x".repeat(1_999)}…`,
    excluded: "\uD83D",
  },
])("logs a bounded, single-line delivery error: $name", ({ error, expected, excluded }) => {
  const log = captureLog();
  logAnnounceGiveUp(createRunEntry({ delivery: { status: "failed", lastError: error } }), "expiry");
  expect(log).toHaveBeenCalledWith(expect.stringContaining(expected));
  const line = String(log.mock.calls[0]?.[0]);
  expect(line).toContain(expected);
  expect(line).not.toContain(excluded);
});
