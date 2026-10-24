import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { bindSubagentRunRecord } from "../../src/agents/subagents/registry/subagent-registry.store.codec.js";
import { writeSubagentRunValuesInDatabase } from "../../src/agents/subagents/registry/subagent-registry.store.kernel.js";
import type { SubagentRunRecord } from "../../src/agents/subagents/registry/subagent-registry.types.js";
import { insertRegistryWorktreeInDatabase } from "../../src/agents/worktrees/registry-run-end.worker.js";
import { resolveRepositoryIdentity } from "../../src/agents/worktrees/repository-paths.js";
import {
  readExactSessionEntryRow,
  writeSessionEntry,
} from "../../src/config/sessions/session-accessor.sqlite-entry-store.js";
import { cronStoreKey } from "../../src/cron/store/key.js";
import { assertCronStoreCanPersist } from "../../src/cron/store/row-codec.js";
import { saveCronStoreInDatabase } from "../../src/cron/store/save.kernel.js";
import type { CronStoredJob } from "../../src/cron/types.js";
import { insertOperatorApprovalInDatabase } from "../../src/gateway/operator-approval-store.kernel.worker.js";
import { insertProjectRegistryInDatabase } from "../../src/projects/project-registry.kernel.js";
import { runOpenClawAgentWriteTransaction } from "../../src/state/openclaw-agent-db.js";
import { runOpenClawStateWriteTransaction } from "../../src/state/openclaw-state-db.js";
import {
  TEAM_SHAPE_RUN_SLOT_MS,
  teamShapeRootSessionCount,
  waitForTeamShapeWriteBudget,
} from "./team-shape-sessions.js";

const executeFile = promisify(execFile);
const DAY_MS = 86_400_000;

type FixtureSession = { sessionKey: string; sessionId: string };

export type TeamShapeExtrasOptions = {
  stateDir: string;
  sessions: FixtureSession[];
  retainedRuns: number;
  settledRuns?: boolean;
  approvals: number;
  cronJobs: number;
  cronAnnounceLast?: boolean;
  projects: number;
  worktreeFiles?: number;
  worktreeFileBytes?: number;
  worktreeInstallFailure?: boolean;
  worktreeColdCommits?: number;
  nestedRepository?: boolean;
  githubOptionsConnected?: boolean;
  now: number;
};

function retainedRun(index: number, options: TeamShapeExtrasOptions): SubagentRunRecord {
  const rootCount = teamShapeRootSessionCount(options.sessions.length);
  const childCount = options.sessions.length - rootCount;
  const childOffset = index % childCount;
  const child = options.sessions[rootCount + childOffset]!;
  const parent = options.sessions[childOffset % rootCount]!;
  const runId = `team-shape-run-${index}`;
  const endedAt =
    options.now - 60_000 - (options.retainedRuns - 1 - index) * TEAM_SHAPE_RUN_SLOT_MS;
  const startedAt = endedAt - 30_000 - (index % 100) * 1_000;
  const slot = index % 20;
  const failed = slot >= 12 && slot < 15;
  const pending =
    !options.settledRuns && slot >= 15 && slot < 18 && index + childCount >= options.retainedRuns;
  const interrupted = !options.settledRuns && slot >= 18;
  const outcome = failed
    ? { status: "error" as const, error: "Synthetic tool exited with status 1" }
    : { status: "ok" as const };
  const task = `Inspect synthetic project ${index % Math.max(1, options.projects)} and report findings.`;
  const resultText = failed ? "Synthetic validation failed." : "Synthetic inspection completed.";
  return {
    runId,
    childSessionKey: child.sessionKey,
    childAgentId: "main",
    childSessionIdentity: { sessionId: child.sessionId },
    requesterSessionKey: parent.sessionKey,
    requesterAgentId: "main",
    controllerSessionKey: parent.sessionKey,
    requesterDisplayKey: parent.sessionKey,
    task,
    taskName: `fixture-task-${index}`,
    cleanup: "keep",
    generation: Math.floor(index / childCount) + 1,
    createdAt: startedAt - 1_000,
    archiveAtMs: options.now + 30 * DAY_MS,
    expectsCompletionMessage: !interrupted,
    endedReason: failed ? "subagent-error" : "subagent-complete",
    execution: interrupted
      ? {
          status: "interrupted",
          interruptionReason: "gateway-restart",
          startedAt,
          endedAt,
          interruptedAt: endedAt,
        }
      : { status: "terminal", startedAt, endedAt, outcome },
    completion: { required: !interrupted, resultText, capturedAt: endedAt },
    delivery: interrupted
      ? { status: "not_required" }
      : pending
        ? {
            status: "pending",
            createdAt: endedAt,
            attemptCount: 1,
            lastAttemptAt: endedAt,
            lastError: "Synthetic requester temporarily unavailable",
            nextAttemptAt: options.now + DAY_MS,
            payload: {
              requesterSessionKey: parent.sessionKey,
              requesterDisplayKey: parent.sessionKey,
              childSessionKey: child.sessionKey,
              childRunId: runId,
              task,
              startedAt,
              endedAt,
              outcome,
              expectsCompletionMessage: true,
            },
          }
        : { status: "delivered", deliveredAt: endedAt + 500 },
    ...(!pending ? { cleanupHandled: true, cleanupCompletedAt: endedAt + 1_000 } : {}),
  };
}

async function seedProjects(options: TeamShapeExtrasOptions) {
  const projectWorktrees: Array<{
    projectId: string;
    repoRoot: string;
    path: string;
    id: string;
    branch: string;
    coldBaseRefs?: string[];
  }> = [];
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Synthetic Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Synthetic Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_AUTHOR_DATE: new Date(options.now).toISOString(),
    GIT_COMMITTER_DATE: new Date(options.now).toISOString(),
  };
  for (let index = 0; index < options.projects; index++) {
    const projectId = `team-shape-project-${index}`;
    const repoRoot = path.join(options.stateDir, "fixture-projects", projectId);
    const worktreePath = path.join(options.stateDir, "fixture-worktrees", projectId);
    const git = (...args: string[]) =>
      executeFile("git", ["-C", repoRoot, ...args], { env: gitEnv });
    await fs.mkdir(repoRoot, { recursive: true });
    await git("init", "--initial-branch=main");
    if (options.githubOptionsConnected) {
      // The registry fingerprint includes the origin; set it before registration.
      await git("remote", "add", "origin", "https://github.com/openclaw-fixture/soak.git");
    }
    await fs.writeFile(path.join(repoRoot, "README.md"), `# Synthetic project ${index}\n`);
    await git("add", "README.md");
    if (index === 0 && options.worktreeInstallFailure) {
      await fs.writeFile(
        path.join(repoRoot, "package.json"),
        JSON.stringify({
          name: "synthetic-attempt-setup",
          private: true,
          packageManager: "pnpm@12.0.0",
          scripts: { preinstall: "exit 1" },
        }),
      );
      await fs.writeFile(
        path.join(repoRoot, "pnpm-lock.yaml"),
        "lockfileVersion: '9.0'\nimporters:\n  .: {}\n",
      );
      await git("add", "package.json", "pnpm-lock.yaml");
    }
    await git("-c", "commit.gpgSign=false", "commit", "-m", "test: seed synthetic project");
    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    const branch = `fixture/task-${index}`;
    const worktreeFiles = index === 0 ? (options.worktreeFiles ?? 0) : 0;
    if (worktreeFiles > 0) {
      await git("checkout", "--detach");
    }
    await git("worktree", "add", "-b", branch, worktreePath);
    if (worktreeFiles > 0) {
      for (let file = 0; file < worktreeFiles; file++) {
        const bucket = path.join(worktreePath, "inventory", String(Math.floor(file / 1_000)));
        if (file % 1_000 === 0) {
          await waitForTeamShapeWriteBudget();
          await fs.mkdir(bucket, { recursive: true });
        }
        const content = Buffer.alloc(options.worktreeFileBytes ?? 0);
        let random = file + 1;
        for (let offset = 0; offset < content.length; offset++) {
          random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
          content[offset] = random >>> 24;
        }
        await fs.writeFile(path.join(bucket, `${file}.txt`), content);
      }
      await git("-C", worktreePath, "add", "inventory");
      await git(
        "-C",
        worktreePath,
        "-c",
        "commit.gpgSign=false",
        "commit",
        "--quiet",
        "-m",
        "test: seed large synthetic inventory",
      );
      // Move the base without materializing a second large checkout in the detached origin.
      await git("branch", "--force", "main", branch);
      await waitForTeamShapeWriteBudget();
    }
    if (index === 0 && options.nestedRepository) {
      const nested = path.join(worktreePath, "nested-repository");
      await fs.mkdir(nested);
      await git("-C", nested, "init", "--initial-branch=main");
      await fs.writeFile(path.join(nested, "README.md"), "# Synthetic nested repository\n");
      await git("-C", nested, "add", "README.md");
      await git(
        "-C",
        nested,
        "-c",
        "commit.gpgSign=false",
        "commit",
        "--quiet",
        "-m",
        "test: seed nested synthetic repository",
      );
    }
    const coldBaseRefs: string[] = [];
    if (index === 0 && options.worktreeColdCommits) {
      const tree = (await git("rev-parse", "refs/heads/main^{tree}")).stdout.trim();
      const parent = (await git("rev-parse", "refs/heads/main")).stdout.trim();
      for (let cold = 0; cold < options.worktreeColdCommits; cold++) {
        const ref = `refs/heads/benchmark-cold-${cold}`;
        const commit = (
          await git("commit-tree", tree, "-p", parent, "-m", `test: cold template ${cold}`)
        ).stdout.trim();
        await git("update-ref", ref, commit);
        coldBaseRefs.push(ref);
      }
    }
    const repository = await resolveRepositoryIdentity(repoRoot);
    const project = runOpenClawStateWriteTransaction(({ db }) => {
      const registered = insertProjectRegistryInDatabase(db, {
        displayName: projectId,
        repoRoot: repository.repoRoot,
        source: "registered",
      });
      insertRegistryWorktreeInDatabase(db, {
        record: {
          id: projectId,
          name: projectId,
          repoFingerprint: repository.fingerprint,
          repoRoot: repository.repoRoot,
          path: worktreePath,
          branch,
          baseRef: "main",
          ownerKind: "manual",
          createdAt: options.now,
          lastActiveAt: options.now,
        },
        provisionedPaths: [],
      });
      return registered;
    });
    projectWorktrees.push({
      projectId: project.id,
      repoRoot,
      path: worktreePath,
      ...(coldBaseRefs.length ? { coldBaseRefs } : {}),
      id: projectId,
      branch,
    });
  }
  return projectWorktrees;
}

/** Offline generation only: the caller owns a new state directory and binds its environment. */
export async function seedTeamShapeExtras(options: TeamShapeExtrasOptions) {
  const started = performance.now();
  if (options.sessions.length === 0 && (options.retainedRuns > 0 || options.approvals > 0)) {
    throw new Error("Retained runs and approvals require at least one fixture session");
  }
  if (options.retainedRuns > 0 && options.sessions.length < 2) {
    throw new Error("Retained runs require a parent and at least one child session");
  }
  const projectWorktrees = await seedProjects(options);
  const records = Array.from({ length: options.retainedRuns }, (_, index) =>
    retainedRun(index, options),
  );
  const latestRuns = new Map(records.map((run) => [run.childSessionKey, run]));
  const retainedRunStates = { successful: 0, failed: 0, pending: 0, interrupted: 0 };
  for (const run of records) {
    const state =
      run.execution.status === "interrupted"
        ? "interrupted"
        : run.delivery?.status === "pending"
          ? "pending"
          : run.execution.outcome?.status === "error"
            ? "failed"
            : "successful";
    retainedRunStates[state]++;
  }
  const childIdentities = new Map<string, NonNullable<SubagentRunRecord["childSessionIdentity"]>>();
  const databaseOptions = {
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: options.stateDir },
  };
  for (let offset = 0; offset < options.sessions.length; offset += 100) {
    runOpenClawAgentWriteTransaction((database) => {
      for (let index = offset; index < Math.min(offset + 100, options.sessions.length); index++) {
        const session = options.sessions[index]!;
        const row = readExactSessionEntryRow(database, session.sessionKey);
        if (!row) {
          throw new Error(`Fixture session is missing: ${session.sessionKey}`);
        }
        const entry = { ...row.entry };
        const project = projectWorktrees[index % projectWorktrees.length];
        if (project) {
          entry.projectId = project.projectId;
          entry.spawnedWorkspaceDir = project.repoRoot;
          entry.spawnedCwd = project.path;
          entry.worktree = { id: project.id, branch: project.branch, repoRoot: project.repoRoot };
        }
        const run = latestRuns.get(session.sessionKey);
        if (run) {
          const parent = readExactSessionEntryRow(database, run.requesterSessionKey)?.entry;
          if (!parent) {
            throw new Error(`Fixture parent session is missing: ${run.requesterSessionKey}`);
          }
          entry.parentSessionKey = run.requesterSessionKey;
          entry.parentSessionId = parent.sessionId;
          entry.parentSessionLifecycleRevision = parent.lifecycleRevision;
          entry.spawnedBy = run.requesterSessionKey;
          entry.spawnedBySessionId = parent.sessionId;
          entry.completionOwnerSessionKey = run.requesterSessionKey;
          entry.spawnDepth = 1;
          entry.lifecycleRunId = run.runId;
          entry.endedAt = run.execution.endedAt;
          const settledAt = run.execution.endedAt! + 1_000;
          entry.updatedAt = Math.max(entry.updatedAt, settledAt);
          entry.lastActivityAt = Math.max(entry.lastActivityAt ?? 0, settledAt);
          entry.lastInteractionAt = Math.max(entry.lastInteractionAt ?? 0, settledAt);
          entry.status =
            run.execution.status === "interrupted"
              ? "interrupted"
              : run.execution.outcome?.status === "error"
                ? "failed"
                : "done";
        }
        writeSessionEntry(database, session.sessionKey, entry, {
          canonicalPreviousEntry: row.entry,
          canonicalPreviousRow: row.row,
        });
        childIdentities.set(session.sessionKey, {
          sessionId: entry.sessionId,
          lifecycleRevision: entry.lifecycleRevision,
        });
      }
    }, databaseOptions);
  }
  const runs = records.map((run) =>
    bindSubagentRunRecord({
      ...run,
      childSessionIdentity: childIdentities.get(run.childSessionKey),
    }),
  );
  if (runs.length > 0) {
    runOpenClawStateWriteTransaction((database) => {
      writeSubagentRunValuesInDatabase(database, runs, []);
    });
  }
  // Startup deliberately cancels this previous epoch's pending approvals. The
  // fixture exercises the real recovery backlog without granting live authority.
  for (let index = 0; index < options.approvals; index++) {
    const session = options.sessions[index % options.sessions.length]!;
    const result = insertOperatorApprovalInDatabase({
      approval: {
        id: `team-shape-approval-${index}`,
        kind: "exec",
        presentation: {
          kind: "exec",
          commandText: `echo synthetic-approval-${index}`,
          commandPreview: `echo synthetic-approval-${index}`,
          warningText: null,
          host: "gateway",
          nodeId: null,
          agentId: "main",
          allowedDecisions: ["allow-once", "deny"],
        },
        source: { agentId: "main", ...session, toolName: "exec" },
        audienceSessionKeys: [session.sessionKey],
        runtimeEpoch: "team-shape-offline-generation",
        createdAtMs: options.now - index * 1_000,
        expiresAtMs: options.now + DAY_MS,
      },
    });
    if (result.outcome !== "inserted") {
      throw new Error(`Synthetic approval ${index} was not inserted: ${result.outcome}`);
    }
  }
  const jobs: CronStoredJob[] = Array.from({ length: options.cronJobs }, (_, index) => ({
    id: `team-shape-cron-${index}`,
    name: `Synthetic periodic inspection ${index}`,
    agentId: "main",
    enabled: false,
    createdAtMs: options.now - DAY_MS,
    updatedAtMs: options.now,
    schedule:
      index % 2 === 0
        ? { kind: "every", everyMs: 3_600_000, anchorMs: options.now }
        : { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
    wakeMode: "next-heartbeat",
    ...(options.cronAnnounceLast
      ? {
          sessionTarget: "isolated" as const,
          sessionKey: options.sessions[1]!.sessionKey,
          payload: { kind: "agentTurn" as const, message: `Synthetic inspection ${index}` },
          delivery: { mode: "announce" as const, channel: "last" },
          failureAlert: false as const,
        }
      : {
          sessionTarget: "main" as const,
          payload: { kind: "systemEvent" as const, text: `Synthetic inspection ${index}` },
        }),
    state: { lastRunAtMs: options.now - DAY_MS, lastRunStatus: index % 5 === 0 ? "error" : "ok" },
  }));
  if (jobs.length > 0) {
    const store = { version: 1 as const, jobs };
    assertCronStoreCanPersist(store);
    const storeKey = cronStoreKey(path.join(options.stateDir, "cron", "jobs.json"));
    runOpenClawStateWriteTransaction((database) => {
      saveCronStoreInDatabase(database, storeKey, store);
    });
  }
  return {
    retainedRuns: runs.length,
    settledRuns: options.settledRuns ?? false,
    retainedRunStates,
    approvals: options.approvals,
    cronJobs: jobs.length,
    cronAnnounceLast: options.cronAnnounceLast ?? false,
    projects: projectWorktrees.length,
    githubOptionsConnected: options.githubOptionsConnected ?? false,
    worktreeFiles: options.worktreeFiles ?? 0,
    worktreeFileBytes: options.worktreeFileBytes ?? 0,
    worktreeInstallFailure: options.worktreeInstallFailure ?? false,
    worktreeColdCommits: options.worktreeColdCommits ?? 0,
    nestedRepository: options.nestedRepository ?? false,
    projectWorktrees,
    extrasGenerationMs: performance.now() - started,
  };
}
