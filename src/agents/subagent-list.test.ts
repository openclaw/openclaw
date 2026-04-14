import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { updateSessionStore } from "../config/sessions/store.js";
import { buildRepoSlotBranchName } from "./repo-slots.js";
import { buildSubagentList } from "./subagent-list.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

let testWorkspaceDir = os.tmpdir();
const execFileAsync = promisify(execFile);

beforeAll(async () => {
  testWorkspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-list-"));
});

afterAll(async () => {
  await fs.rm(testWorkspaceDir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  });
});

beforeEach(() => {
  resetSubagentRegistryForTests();
});

describe("buildSubagentList", () => {
  it("returns empty active and recent sections when no runs exist", () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const list = buildSubagentList({
      cfg,
      runs: [],
      recentMinutes: 30,
      taskMaxChars: 110,
    });
    expect(list.active).toEqual([]);
    expect(list.recent).toEqual([]);
    expect(list.text).toContain("active subagents:");
    expect(list.text).toContain("recent (last 30m):");
  });

  it("truncates long task text in list lines", () => {
    const run = {
      runId: "run-long-task",
      childSessionKey: "agent:main:subagent:long-task",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "This is a deliberately long task description used to verify that subagent list output keeps the full task text instead of appending ellipsis after a short hard cutoff.",
      cleanup: "keep",
      createdAt: 1000,
      startedAt: 1000,
    } satisfies SubagentRunRecord;
    addSubagentRunForTests(run);
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const list = buildSubagentList({
      cfg,
      runs: [run],
      recentMinutes: 30,
      taskMaxChars: 110,
    });
    expect(list.active[0]?.line).toContain(
      "This is a deliberately long task description used to verify that subagent list output keeps the full task text",
    );
    expect(list.active[0]?.line).toContain("...");
    expect(list.active[0]?.line).not.toContain("after a short hard cutoff.");
  });

  it("keeps ended orchestrators active while descendants remain pending", () => {
    const now = Date.now();
    const orchestratorRun = {
      runId: "run-orchestrator-ended",
      childSessionKey: "agent:main:subagent:orchestrator-ended",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "orchestrate child workers",
      cleanup: "keep",
      createdAt: now - 120_000,
      startedAt: now - 120_000,
      endedAt: now - 60_000,
      outcome: { status: "ok" },
    } satisfies SubagentRunRecord;
    addSubagentRunForTests(orchestratorRun);
    addSubagentRunForTests({
      runId: "run-orchestrator-child-active",
      childSessionKey: "agent:main:subagent:orchestrator-ended:subagent:child",
      requesterSessionKey: "agent:main:subagent:orchestrator-ended",
      requesterDisplayKey: "subagent:orchestrator-ended",
      task: "child worker still running",
      cleanup: "keep",
      createdAt: now - 30_000,
      startedAt: now - 30_000,
    });
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const list = buildSubagentList({
      cfg,
      runs: [orchestratorRun],
      recentMinutes: 30,
      taskMaxChars: 110,
    });

    expect(list.active[0]?.status).toBe("active (waiting on 1 child)");
    expect(list.recent).toEqual([]);
  });

  it("formats io and prompt/cache usage from session entries", async () => {
    const run = {
      runId: "run-usage",
      childSessionKey: "agent:main:subagent:usage",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do thing",
      cleanup: "keep",
      createdAt: 1000,
      startedAt: 1000,
    } satisfies SubagentRunRecord;
    addSubagentRunForTests(run);
    const storePath = path.join(testWorkspaceDir, "sessions-subagent-list-usage.json");
    await updateSessionStore(storePath, (store) => {
      store["agent:main:subagent:usage"] = {
        sessionId: "child-session-usage",
        updatedAt: Date.now(),
        inputTokens: 12,
        outputTokens: 1000,
        totalTokens: 197000,
        model: "opencode/claude-opus-4-6",
      };
    });
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { store: storePath },
    } as OpenClawConfig;
    const list = buildSubagentList({
      cfg,
      runs: [run],
      recentMinutes: 30,
      taskMaxChars: 110,
    });

    expect(list.active[0]?.line).toMatch(/tokens 1(\.0)?k \(in 12 \/ out 1(\.0)?k\)/);
    expect(list.active[0]?.line).toContain("prompt/cache 197k");
    expect(list.active[0]?.line).not.toContain("1k io");
  });

  it("exposes structured operator state and workspace git summary", async () => {
    const repoDir = path.join(testWorkspaceDir, "subagent-state-repo");
    await fs.mkdir(repoDir, { recursive: true });
    await execFileAsync("git", ["init", "-b", "status-branch"], { cwd: repoDir });
    const run = {
      runId: "run-state",
      childSessionKey: "agent:main:subagent:state",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "monitor status",
      cleanup: "keep",
      createdAt: 1000,
      startedAt: 1000,
      workspaceDir: repoDir,
      operatorState: {
        stage: "running",
        lastToolName: "exec",
        lastToolAction: "pnpm test",
        waitingReason: "Awaiting command approval",
        filesTouched: ["src/a.ts", "src/b.ts"],
        verificationStatus: "pending",
        verificationNote: "pnpm test --filter subagents",
        progressNote: "Tests started",
        confidence: "medium",
      },
    } satisfies SubagentRunRecord;
    addSubagentRunForTests(run);
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;

    const list = buildSubagentList({
      cfg,
      runs: [run],
      recentMinutes: 30,
      taskMaxChars: 110,
    });

    expect(list.active[0]?.line).toContain("waiting: Awaiting command approval");
    expect(list.active[0]?.line).toContain("verify: pending (pnpm test --filter subagents)");
    expect(list.active[0]?.line).toContain("files: 2");
    expect(list.active[0]?.line).toContain("branch: status-branch");
    expect(list.active[0]?.state).toMatchObject({
      stage: "running",
      workspaceDir: repoDir,
      workspaceSlot: "subagent-state-repo",
      repo: "subagent-state-repo",
      branch: "status-branch",
      lastToolName: "exec",
      lastToolAction: "pnpm test",
      waitingReason: "Awaiting command approval",
      filesTouched: ["src/a.ts", "src/b.ts"],
      verificationStatus: "pending",
      verificationNote: "pnpm test --filter subagents",
      progressNote: "Tests started",
      confidence: "medium",
    });
  });

  it("exposes repo slot workspace slot and branch from slot metadata", async () => {
    const slotRoot = path.join(
      testWorkspaceDir,
      "repo-slots",
      "openclaw-test",
      "process-test-lane-b",
    );
    const repoDir = path.join(slotRoot, "repo");
    const branch = buildRepoSlotBranchName("process-test-lane-b");
    await fs.mkdir(repoDir, { recursive: true });
    await execFileAsync("git", ["init", "-b", branch], { cwd: repoDir });
    await fs.writeFile(
      path.join(slotRoot, "slot.json"),
      `${JSON.stringify(
        {
          version: 1,
          slot: "process-test-lane-b",
          branch,
          repoRoot: "/tmp/source/openclaw",
          repoName: "openclaw",
          repoKey: "openclaw-test",
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          materialization: "worktree",
          workspaceDir: repoDir,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const run = {
      runId: "run-slot-state",
      childSessionKey: "agent:main:subagent:slot-state",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "monitor slot status",
      cleanup: "keep",
      createdAt: 1000,
      startedAt: 1000,
      workspaceDir: repoDir,
      operatorState: {
        stage: "running",
      },
    } satisfies SubagentRunRecord;
    addSubagentRunForTests(run);
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;

    const list = buildSubagentList({
      cfg,
      runs: [run],
      recentMinutes: 30,
      taskMaxChars: 110,
    });

    expect(list.active[0]?.line).toContain(`branch: ${branch}`);
    expect(list.active[0]?.state).toMatchObject({
      workspaceDir: repoDir,
      workspaceSlot: "process-test-lane-b",
      repo: "openclaw",
      branch,
    });
  });
});
