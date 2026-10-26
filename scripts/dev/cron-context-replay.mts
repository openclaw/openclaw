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
import { pathToFileURL } from "node:url";
import JSON5 from "json5";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import { tryResolveAmbientOwnerAgentId } from "../../src/agents/agent-scope-config.js";
import { isRuntimeToolAllowed } from "../../src/agents/tool-policy-match.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import {
  CRON_AGENT_SELECTION_REQUIRED_MESSAGE,
  tryResolveCronJobEffectiveAgentId,
} from "../../src/cron/agent-id.js";
import {
  assembleScheduledAdmissionFacts,
  parentRowFactsFromEntry,
  scheduledParentLinkOf,
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
  type ScheduledAdmissionFacts,
} from "../../src/cron/execution-context.js";
import { resolveCronSessionTargetSessionKey } from "../../src/cron/session-target.js";
import { resolveCronRunToolsAllow } from "../../src/cron/tools-allow.js";
import type { CronStoredJob } from "../../src/cron/types.js";
import { decodeGatewayOperatorRecoverySource } from "../../src/gateway/operator-run-recovery-source.codec.js";

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

type ParentRow = NonNullable<ScheduledAdmissionFacts["parentRow"]>;

// Keeps the discriminators the builder reads from a stored operator source. A
// source that does not decode stays undecodable, so the fixture keeps failing.
function anonymizeOperatorSource(
  operatorSource: NonNullable<CronStoredJob["operatorSource"]>,
  agentId: string,
  key: (value: string) => string,
): CronStoredJob["operatorSource"] {
  let source;
  try {
    source = decodeGatewayOperatorRecoverySource(operatorSource.source);
  } catch {
    return { source: { version: 1 }, executionRevision: "execution-1" } as never;
  }
  const { snapshot } = source;
  return {
    executionRevision: "execution-1",
    source: {
      version: 1,
      agentId: source.agentId === agentId ? "main" : "other",
      sessionKey: key(source.sessionKey),
      sessionId: "parent-session",
      ...(source.lifecycleRevision ? { lifecycleRevision: "rev-1" } : {}),
      sourceRunId: "source-run",
      snapshot: {
        profileId: "profile-1",
        scopes: [...snapshot.scopes],
        assignedRole: snapshot.assignedRole === null ? null : "role",
        githubLogin: null,
        grant: null,
        aliasBindingIds: [],
        authPolicy: {
          generation: "",
          grantGeneration: "generation",
          role: "operator",
          authMethod: snapshot.authPolicy.authMethod,
        },
        controlUiAdmin: snapshot.controlUiAdmin,
        localOperator: snapshot.localOperator,
        sourceIngress: snapshot.sourceIngress,
      },
    },
  };
}

/**
 * Replaces a parent row's private values while keeping how it relates to the
 * job's stored parent link: same or replaced session, same or changed lifecycle
 * revision, and whether its worktree still exists.
 */
export function anonymizeParentRow(
  row: ParentRow | undefined,
  job: CronStoredJob,
): ParentRow | undefined {
  if (!row || row.missing) {
    return row;
  }
  const link = scheduledParentLinkOf(job);
  const worktreePath = "/work/parent/worktree";
  return {
    sessionId: row.sessionId === link?.sessionId ? "parent-session" : "replaced-session",
    ...(row.lifecycleRevision
      ? { lifecycleRevision: row.lifecycleRevision === link?.lifecycleRevision ? "rev-1" : "rev-2" }
      : {}),
    archived: row.archived,
    sandboxRequired: row.sandboxRequired,
    ...(row.workspaceDir ? { workspaceDir: "/work/parent" } : {}),
    ...(row.cwd ? { cwd: row.cwd === row.worktree?.path ? worktreePath : "/work/parent/cwd" } : {}),
    ...(row.worktree ? { worktree: { path: worktreePath, exists: row.worktree.exists } } : {}),
  };
}

// Long agent-turn creator snapshots reduce to whether automations was allowed.
function anonymizeAgentToolsAllow(toolsAllow: string[]): string[] {
  if (toolsAllow.length <= 5) {
    return toolsAllow;
  }
  return isRuntimeToolAllowed("automations", toolsAllow) ? ["read", "automations"] : ["read"];
}

// Every payload kind keeps its tool cap fields; prompts, text, argv and script
// bodies become placeholders.
function anonymizePayload(payload: CronStoredJob["payload"]): CronStoredJob["payload"] {
  const tools = {
    ...("toolsAllow" in payload && payload.toolsAllow
      ? { toolsAllow: [...payload.toolsAllow] }
      : {}),
    ...("toolsAllowIsDefault" in payload && payload.toolsAllowIsDefault !== undefined
      ? { toolsAllowIsDefault: payload.toolsAllowIsDefault }
      : {}),
  };
  if (payload.kind === "agentTurn") {
    return {
      kind: "agentTurn",
      message: "fixture",
      ...tools,
      ...(tools.toolsAllow ? { toolsAllow: anonymizeAgentToolsAllow(tools.toolsAllow) } : {}),
      ...(payload.externalContentSource
        ? { externalContentSource: payload.externalContentSource }
        : {}),
    };
  }
  if (payload.kind === "script") {
    return { kind: "script", script: "return null", ...tools };
  }
  if (payload.kind === "systemEvent") {
    return { kind: "systemEvent", text: "fixture", ...tools };
  }
  return { kind: "command", argv: ["true"] };
}

/**
 * Fixture jobs keep the fields the builder and tool-cap resolver read;
 * identifiers, names, prompts, scripts and paths become stable placeholders, so
 * the shape stays a valid stored job. Equal session keys stay equal, so parent
 * and requester relationships survive.
 */
export function anonymize(job: CronStoredJob, agentId: string, index: number): CronStoredJob {
  const keys = new Map<string, string>();
  const key = (value: string) => {
    if (!keys.has(value)) {
      keys.set(value, `agent:main:dashboard:session-${keys.size + 1}`);
    }
    return keys.get(value) as string;
  };
  const channelRequester = job.toolsAllowProvenance?.channelRequester;
  const target = resolveCronSessionTargetSessionKey(job.sessionTarget);
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
    payload: anonymizePayload(job.payload),
    delivery: { mode: "none" },
    state: {},
    ...(job.trigger?.script.trim()
      ? {
          trigger: {
            script: "return null",
            ...(job.trigger.once !== undefined ? { once: job.trigger.once } : {}),
          },
        }
      : {}),
    ...(job.runtimeAuthority
      ? {
          runtimeAuthority: {
            version: 1,
            runtimeId: job.runtimeAuthority.runtimeId,
            namespace: job.runtimeAuthority.namespace,
            payload: {},
          },
        }
      : {}),
    ...(job.runtimeAuthorityRecoveryRequired ? { runtimeAuthorityRecoveryRequired: true } : {}),
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
    ...(job.operatorSource
      ? { operatorSource: anonymizeOperatorSource(job.operatorSource, agentId, key) }
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
            ...(channelRequester
              ? {
                  channelRequester: {
                    version: 1,
                    channel: channelRequester.channel,
                    accountId: "default",
                    senderId: "sender-1",
                  },
                }
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
      const agentId = tryResolveCronJobEffectiveAgentId(job, tryResolveAmbientOwnerAgentId(cfg));
      if (!agentId) {
        rows.push({
          job: job.name || job.id,
          agentId: "(unresolved)",
          enabled: job.enabled,
          principal: "fail",
          ownerCheck: "not-needed",
          divergence: {
            status: "fail",
            labels: {},
            changes: [],
            reason: CRON_AGENT_SELECTION_REQUIRED_MESSAGE,
          },
        });
        continue;
      }
      const runSessionKey = runSessionKeyFor(job, agentId);
      const parentKey = scheduledParentLinkOf(job)?.sessionKey;
      let parentRow;
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
        const fixtureJob = anonymize(job, agentId, fixtures.size + 1);
        const fixtureParentRow = anonymizeParentRow(parentRow, job);
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
