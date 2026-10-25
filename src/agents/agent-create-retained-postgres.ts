import { statSync } from "node:fs";
import { createSessionWorkerExecutionSource } from "../config/sessions/session-worker-execution-source.js";
import { resolveConfiguredAgentDatabaseTargets } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getDatabaseEngineInput } from "../infra/database-engine/context.js";
import { runWithAgentCreationClaim } from "../state/agent-creation-claim.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import { createAgentSchemaInspectionWorker } from "../state/openclaw-agent-schema-inspection-worker.js";
import { DuplicateAgentError } from "./agent-create-error.js";

export async function admitRetainedPostgresAgentStores(params: {
  config: OpenClawConfig;
  agentId: string;
  assertCurrent: () => void;
}): Promise<void> {
  if (!getDatabaseEngineInput("agent")) {
    return;
  }
  const { agentId, assertCurrent } = params;
  const targets = resolveConfiguredAgentDatabaseTargets(params.config, {
    env: process.env,
    agentId,
  }).filter((target) => statSync(target.path, { throwIfNoEntry: false })?.isFile());
  if (targets.length === 0) {
    return;
  }
  const retainedTargets: typeof targets = [];
  {
    await using inspector = createAgentSchemaInspectionWorker();
    for (const target of targets) {
      assertCurrent();
      // Schema-only inspection leaves unanchored SQLite files to fresh creation.
      const inspection = await inspector.inspect({
        pathname: target.path,
        agentId,
        env: process.env,
        supportedVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
      });
      assertCurrent();
      if (!inspection) {
        continue;
      }
      if (inspection.failure) {
        throw inspection.failure;
      }
      if (inspection.reason) {
        throw new Error(inspection.reason);
      }
      if (
        inspection.version <= 0 ||
        inspection.version > OPENCLAW_AGENT_SCHEMA_VERSION ||
        inspection.agentSchemaMeta?.agentId !== agentId ||
        inspection.agentSchemaMeta.role !== "agent" ||
        inspection.agentSchemaMeta.schemaVersion !== inspection.version
      ) {
        throw new DuplicateAgentError(
          `Agent ${agentId} retained PostgreSQL store cannot be restored. Restore its matching PostgreSQL namespace before rerunning agents add.`,
        );
      }
      retainedTargets.push(target);
    }
  }
  await runWithAgentCreationClaim({ agentId }, async () => {
    for (const target of retainedTargets) {
      assertCurrent();
      const execution = captureOpenClawAgentDatabaseExecution(target);
      try {
        const admitted = await execution.runExisting(
          createSessionWorkerExecutionSource(
            assertCurrent,
            `Agent ${agentId} retained PostgreSQL admission expired`,
          ),
          async () => true,
        );
        if (admitted !== true) {
          throw new DuplicateAgentError(
            `Agent ${agentId} retained PostgreSQL store is missing. Restore its matching PostgreSQL namespace before rerunning agents add.`,
          );
        }
      } finally {
        await execution.release();
      }
    }
  });
  assertCurrent();
}
