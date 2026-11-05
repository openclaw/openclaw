// Offline synthetic state for the real Gateway session polling workload.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";

const { values } = parseArgs({
  options: {
    sessions: { type: "string", default: "2600" },
    placements: { type: "string", default: "177" },
    bound: { type: "string", default: "46" },
    "orphan-recovery": { type: "boolean", default: false },
    "orphan-transient-control": { type: "boolean", default: false },
  },
});
const count = (value: string | undefined) => {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error("Fixture counts must be nonnegative integers");
  }
  return result;
};
const sessions = count(values.sessions);
const placements = count(values.placements);
const bound = count(values.bound);
const orphanRecovery = values["orphan-recovery"];
const transientControl = values["orphan-transient-control"];
if (orphanRecovery && transientControl) {
  throw new Error("Choose orphan recovery or its separate transient control");
}
if (bound > placements || placements > sessions) {
  throw new Error("Require bound <= placements <= sessions");
}
const configPath = process.env.OPENCLAW_CONFIG_PATH;
const stateDir = process.env.OPENCLAW_STATE_DIR;
if (!configPath || !stateDir) {
  throw new Error("An explicit synthetic config and state directory are required");
}
const config: OpenClawConfig = JSON.parse(readFileSync(configPath, "utf8"));
const entries = config.agents?.entries ?? {};
const [agentDb, stateDb, { writeSessionEntry }, { ensureLocal }] = await Promise.all([
  import("../../src/state/openclaw-agent-db.js"),
  import("../../src/state/openclaw-state-db.js"),
  import("../../src/config/sessions/session-accessor.sqlite-entry-store.js"),
  import("../../src/gateway/worker-environments/placement-row-codec.js"),
]);
const agents = Object.keys(entries);
if (agents.length === 0) {
  throw new Error("Synthetic fixture requires configured agents");
}
const now = Date.now();
try {
  for (const agentId of agents) {
    const workspace = entries[agentId]?.workspace;
    if (workspace) {
      mkdirSync(workspace, { recursive: true });
    }
  }
  if (orphanRecovery) {
    if (bound >= placements - 1) {
      throw new Error("Orphan recovery needs a no-binding and an absent-entry placement");
    }
    // listAsync orders session IDs lexically; skip the three warm retry batches.
    const index = Array.from({ length: placements }, (_, value) => value).toSorted(
      (left, right) => {
        const leftId = `polling-${left}`;
        const rightId = `polling-${right}`;
        return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
      },
    )[25];
    if (index === undefined || index < bound || index === placements - 1) {
      throw new Error("Orphan recovery needs a no-binding session at lexical position 25");
    }
    const agentId = agents[index % agents.length]!;
    const root = entries[agentId]?.workspace;
    if (!root) {
      throw new Error("Restoration requires a configured synthetic workspace");
    }
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args]);
    git("init", "-q", "-b", "main");
    git(
      "-c",
      "user.name=Synthetic Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "Synthetic orphan cleanup fixture",
    );
    const cleanupRef = "refs/openclaw/worker-result-cleanup/orphan-recovery";
    git("update-ref", cleanupRef, "HEAD");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      path.join(stateDir, "orphan-recovery-fixture.json"),
      JSON.stringify(
        {
          agentId,
          sessionKey: `agent:${agentId}:polling-${index}`,
          sessionId: `polling-${index}`,
          root,
          cleanupRef,
          absentSessionKey: `agent:${agents[(placements - 1) % agents.length]}:polling-${placements - 1}`,
        },
        null,
        2,
      ),
    );
  }
  for (let offset = 0; offset < sessions; offset += 100) {
    for (const [agentIndex, agentId] of agents.entries()) {
      agentDb.runOpenClawAgentWriteTransaction(
        (database) => {
          for (let index = offset; index < Math.min(offset + 100, sessions); index++) {
            if (index % agents.length !== agentIndex) {
              continue;
            }
            if (orphanRecovery && index === placements - 1) {
              continue;
            }
            const sessionId = `polling-${index}`;
            const sessionKey = `agent:${agentId}:${sessionId}`;
            writeSessionEntry(database, sessionKey, {
              sessionId,
              updatedAt: now,
              lifecycleRevision: `polling-${index}`,
              ...(transientControl
                ? { repositoryWorkspaceId: "synthetic-unavailable-repository" }
                : {}),
              ...(index < bound
                ? {
                    worktree: {
                      id: `missing-${index}`,
                      branch: `fixture-${index}`,
                      repoRoot: path.join(stateDir, "synthetic-repository"),
                    },
                  }
                : {}),
            });
          }
        },
        { agentId },
      );
    }
  }
  stateDb.runOpenClawStateWriteTransaction(({ db }) => {
    for (let index = 0; index < placements; index++) {
      const agentId = agents[index % agents.length]!;
      const sessionId = `polling-${index}`;
      ensureLocal(db, { agentId, sessionId, sessionKey: `agent:${agentId}:${sessionId}` }, now);
    }
  });
  console.log(JSON.stringify({ sessions, placements, bound, agents: agents.length }));
} finally {
  await agentDb.closeOpenClawAgentDatabasesAsync();
  await stateDb.closeOpenClawStateDatabaseAsync();
}
