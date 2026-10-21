// Development replay for the scheduled-run execution context.
//
// Copies a Gateway's state database and agent session databases into a private
// temporary directory with SQLite's online backup, then, using only the copies,
// builds each stored job's execution context and labels where it differs from
// the decisions the existing code makes. The live databases are only read.
//
//   node --import tsx scripts/dev/cron-context-replay.mts [--state-dir ~/.openclaw]
//     [--config <path>] [--json] [--emit-fixtures <file>]
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import JSON5 from "json5";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import { isRuntimeToolAllowed } from "../../src/agents/tool-policy-match.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import {
  assembleScheduledAdmissionFacts,
  parentRowFactsFromEntry,
} from "../../src/cron/execution-context-admission.js";
import {
  compareScheduledDecisions,
  type ScheduledDivergence,
} from "../../src/cron/execution-context-projection.js";
import {
  replayScheduledContextFixture,
  type ScheduledContextFixture,
} from "../../src/cron/execution-context.fixtures.test-support.js";
import {
  buildScheduledExecutionContext,
  resolveScheduledRequester,
} from "../../src/cron/execution-context.js";
import { resolveCronSessionTargetSessionKey } from "../../src/cron/session-target.js";
import { resolveCronRunToolsAllow } from "../../src/cron/tools-allow.js";
import type { CronStoredJob } from "../../src/cron/types.js";

type Args = { stateDir: string; configPath?: string; json: boolean; emitFixtures?: string };

function parseArgs(argv: string[]): Args {
  const args: Args = { stateDir: path.join(homedir(), ".openclaw"), json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next) {
        throw new Error(`${flag} needs a value`);
      }
      index += 1;
      return next;
    };
    if (flag === "--state-dir") {
      args.stateDir = value();
    } else if (flag === "--config") {
      args.configPath = value();
    } else if (flag === "--json") {
      args.json = true;
    } else if (flag === "--emit-fixtures") {
      args.emitFixtures = value();
    } else {
      throw new Error(`unknown flag ${flag}`);
    }
  }
  return args;
}

async function exists(file: string) {
  return stat(file).then(
    () => true,
    () => false,
  );
}

async function copyDatabase(source: string, target: string) {
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    await backup(db, target);
  } finally {
    db.close();
  }
  return new DatabaseSync(target, { readOnly: true });
}

type ReplayRow = {
  job: string;
  agentId: string;
  enabled: boolean;
  principal: string;
  placement?: string;
  ownerCheck: "checked" | "unverified" | "not-needed";
  divergence: ScheduledDivergence;
};

function runSessionKeyFor(job: CronStoredJob, agentId: string) {
  return (
    resolveCronSessionTargetSessionKey(job.sessionTarget) ??
    `agent:${agentId}:cron:${job.id}:run:replay`
  );
}

// Fixture jobs keep the fields the builder reads; identifiers, names, prompts
// and paths become stable placeholders, so the shape stays a valid stored job.
function anonymize(job: CronStoredJob, index: number): CronStoredJob {
  const keys = new Map<string, string>();
  const key = (value: string) => {
    if (!keys.has(value)) {
      keys.set(value, `agent:main:dashboard:session-${keys.size + 1}`);
    }
    return keys.get(value) as string;
  };
  const target = resolveCronSessionTargetSessionKey(job.sessionTarget);
  const payload =
    job.payload.kind === "agentTurn"
      ? {
          kind: "agentTurn" as const,
          message: "fixture",
          ...(job.payload.toolsAllow
            ? {
                // Long creator snapshots reduce to whether automations was allowed.
                toolsAllow:
                  job.payload.toolsAllow.length > 5
                    ? isRuntimeToolAllowed("automations", job.payload.toolsAllow)
                      ? ["read", "automations"]
                      : ["read"]
                    : [...job.payload.toolsAllow],
              }
            : {}),
          ...(job.payload.toolsAllowIsDefault !== undefined
            ? { toolsAllowIsDefault: job.payload.toolsAllowIsDefault }
            : {}),
          ...(job.payload.externalContentSource
            ? { externalContentSource: job.payload.externalContentSource }
            : {}),
        }
      : job.payload.kind === "command"
        ? { kind: "command" as const, argv: ["true"] }
        : job.payload;
  return {
    id: `fixture-job-${index}`,
    agentId: "main",
    name: `fixture ${index}`,
    enabled: job.enabled,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: target ? `session:${key(target)}` : job.sessionTarget,
    wakeMode: "now",
    payload,
    delivery: { mode: "none" },
    state: {},
    ...(job.owner
      ? {
          owner: {
            agentId: "main",
            ...(job.owner.sessionKey ? { sessionKey: key(job.owner.sessionKey) } : {}),
            ...(job.owner.accountId ? { accountId: "default" } : {}),
          },
        }
      : {}),
    ...(job.scheduledToolPolicy
      ? {
          scheduledToolPolicy:
            job.scheduledToolPolicy.mode === "account"
              ? {
                  version: 1,
                  mode: "account",
                  ownerSessionKey: key(job.scheduledToolPolicy.ownerSessionKey),
                  ownerAccountId: "default",
                }
              : job.scheduledToolPolicy,
        }
      : {}),
    ...(job.sourceConversation
      ? {
          sourceConversation: {
            sessionKey: key(job.sourceConversation.sessionKey),
            sessionId: "parent-session",
            ...(job.sourceConversation.lifecycleRevision ? { lifecycleRevision: "rev-1" } : {}),
          },
        }
      : {}),
    ...(job.createdActor?.type === "human" && job.createdActor.source === "profile"
      ? { createdActor: { type: "human", source: "profile", id: "profile-1" } }
      : {}),
    ...(job.toolsAllowProvenance
      ? {
          toolsAllowProvenance: {
            version: 1,
            source: "final-executable-surface",
            ...(job.toolsAllowProvenance.callerOrigin
              ? { callerOrigin: job.toolsAllowProvenance.callerOrigin }
              : {}),
          },
        }
      : {}),
    ...(job.inferenceBinding
      ? {
          inferenceBinding: {
            ...job.inferenceBinding,
            profileId: "provider:profile",
            authorizationId: "authorization",
          },
        }
      : {}),
  } as CronStoredJob;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stateDb = path.join(args.stateDir, "state", "openclaw.sqlite");
  const configPath = args.configPath ?? path.join(args.stateDir, "openclaw.json");
  const cfg: OpenClawConfig = (await exists(configPath))
    ? (JSON5.parse(await readFile(configPath, "utf8")) as OpenClawConfig)
    : {};
  const workDir = await mkdtemp(path.join(tmpdir(), "cron-context-replay-"));
  await chmod(workDir, 0o700);
  const opened: DatabaseSync[] = [];
  try {
    const state = await copyDatabase(stateDb, path.join(workDir, "state.sqlite"));
    opened.push(state);
    const agentsDir = path.join(args.stateDir, "agents");
    const agentDbs = new Map<string, DatabaseSync>();
    for (const agentId of await readdir(agentsDir).catch(() => [])) {
      const source = path.join(agentsDir, agentId, "agent", "openclaw-agent.sqlite");
      if (await exists(source)) {
        const db = await copyDatabase(source, path.join(workDir, `agent-${agentId}.sqlite`));
        opened.push(db);
        agentDbs.set(agentId, db);
      }
    }
    const profiles = new Map(
      (
        state.prepare("select id, merged_into from user_profiles").all() as Array<{
          id: string;
          merged_into: string | null;
        }>
      ).map((row) => [row.id, row.merged_into]),
    );
    const jobs = (
      state.prepare("select job_json from cron_jobs").all() as Array<{ job_json: string }>
    ).map((row) => JSON.parse(row.job_json) as CronStoredJob);
    const rows: ReplayRow[] = [];
    const fixtures = new Map<string, ScheduledContextFixture>();
    for (const job of jobs) {
      if (job.sessionTarget === "main") {
        continue;
      }
      const agentId = job.agentId ?? "main";
      const runSessionKey = runSessionKeyFor(job, agentId);
      const parentKey =
        job.sourceConversation?.sessionKey ?? job.operatorSource?.source?.sessionKey;
      let parentRow;
      let parentKind = "none";
      if (parentKey) {
        const node = agentDbs
          .get(agentId)
          ?.prepare("select entry_json, archived_at from session_nodes where session_key = ?")
          .get(parentKey) as { entry_json: string; archived_at: number | null } | undefined;
        const entry = node
          ? {
              ...JSON.parse(node.entry_json),
              ...(node.archived_at ? { archivedAt: node.archived_at } : {}),
            }
          : undefined;
        const worktreePath = entry?.worktree ? entry.spawnedCwd : undefined;
        parentRow = parentRowFactsFromEntry(
          entry,
          worktreePath ? await exists(worktreePath) : false,
        );
        parentKind = parentRow.missing
          ? "missing"
          : parentRow.archived
            ? "archived"
            : parentRow.sessionId !== job.sourceConversation?.sessionId &&
                job.sourceConversation !== undefined
              ? "reset"
              : "current";
      }
      const requester = resolveScheduledRequester(job);
      let owner: boolean | undefined;
      let ownerCheck: ReplayRow["ownerCheck"] = "not-needed";
      if (parentRow) {
        if (requester.kind === "profile") {
          owner =
            profiles.has(requester.profileId) &&
            !profiles.get(requester.profileId) &&
            (!cfg.gateway?.roles || requester.profileId === GATEWAY_OWNER_PROFILE_ID);
          ownerCheck = "checked";
        } else if (requester.kind === "unknown") {
          owner = false;
          ownerCheck = "checked";
        } else {
          // Operator-source and channel checks need the live Gateway's authority owners.
          owner = false;
          ownerCheck = "unverified";
        }
      }
      const facts = assembleScheduledAdmissionFacts(
        {
          cfg,
          job,
          trigger: "cron",
          runId: "replay",
          agentId,
          runSessionKey,
          toolsAllow: resolveCronRunToolsAllow(job),
        },
        parentRow,
        owner,
      );
      const result = buildScheduledExecutionContext(job, facts);
      const divergence = compareScheduledDecisions(job, facts, result);
      rows.push({
        job: job.name || job.id,
        agentId,
        enabled: job.enabled,
        principal: result.status === "ready" ? result.facts.principal.kind : result.status,
        ...(result.status === "ready" ? { placement: result.facts.placement } : {}),
        ownerCheck,
        divergence,
      });
      if (args.emitFixtures) {
        const fixtureJob = anonymize(job, fixtures.size + 1);
        const fixtureParentRow = parentRow?.missing
          ? parentRow
          : parentRow
            ? {
                sessionId: parentKind === "reset" ? "replaced-session" : "parent-session",
                ...(job.sourceConversation?.lifecycleRevision
                  ? { lifecycleRevision: "rev-1" }
                  : {}),
                archived: parentRow.archived,
                sandboxRequired: parentRow.sandboxRequired,
                ...(parentRow.workspaceDir ? { workspaceDir: "/work/parent" } : {}),
              }
            : undefined;
        const shapeKey = JSON.stringify({
          ...fixtureJob,
          id: "",
          name: "",
          parentRow: fixtureParentRow,
          owner,
        });
        if (![...fixtures.keys()].includes(shapeKey)) {
          fixtures.set(shapeKey, {
            job: fixtureJob,
            ...(fixtureParentRow ? { parentRow: fixtureParentRow } : {}),
            ...(owner !== undefined ? { owner } : {}),
          });
        }
      }
    }
    const totals: Record<string, number> = {};
    for (const row of rows) {
      const labels = new Set(Object.values(row.divergence.labels));
      for (const label of labels.size > 0 ? labels : new Set([row.divergence.status])) {
        totals[label] = (totals[label] ?? 0) + 1;
      }
    }
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ totals, rows }, null, 2)}\n`);
    } else {
      process.stdout.write(`jobs replayed: ${rows.length} (main-session jobs skipped)\n`);
      process.stdout.write(`jobs per label: ${JSON.stringify(totals)}\n`);
      for (const row of rows) {
        const changes = row.divergence.changes
          .map((change) => `${change.field}=${change.label}`)
          .join(", ");
        process.stdout.write(
          `- ${row.enabled ? "[on] " : "[off]"} ${row.job}: ${row.principal}${row.placement ? `/${row.placement}` : ""} ` +
            `${row.divergence.status}${row.divergence.reason ? ` (${row.divergence.reason})` : ""}` +
            `${changes ? ` | ${changes}` : ""}${row.ownerCheck === "unverified" ? " | owner check unverified" : ""}\n`,
        );
      }
    }
    if (args.emitFixtures) {
      const pinned = [...fixtures.values()];
      for (const fixture of pinned) {
        fixture.expected = replayScheduledContextFixture(fixture);
      }
      await writeFile(args.emitFixtures, `${JSON.stringify(pinned, null, 2)}\n`, {
        mode: 0o600,
      });
      process.stderr.write(`wrote ${fixtures.size} job shapes to ${args.emitFixtures}\n`);
    }
  } finally {
    for (const db of opened) {
      db.close();
    }
    await rm(workDir, { recursive: true, force: true });
  }
}

await main();
