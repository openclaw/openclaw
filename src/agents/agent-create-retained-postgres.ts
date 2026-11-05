import { statSync } from "node:fs";
import { resolveConfiguredAgentDatabaseTargets } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getDatabaseEngineInput } from "../infra/database-engine/context.js";
import { formatErrorMessage } from "../infra/errors.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { createAgentSchemaInspectionWorker } from "../state/openclaw-agent-schema-inspection-worker.js";
import type { AgentSchemaInspection } from "../state/openclaw-agent-schema-inspection.js";
import { DuplicateAgentError } from "./agent-create-error.js";

/** Inspect retained identities before creation can change a workspace, namespace, or config. */
export async function assertRetainedPostgresAgentStores(params: {
  config: OpenClawConfig;
  agentId: string;
  assertCurrent?: () => void;
}): Promise<void> {
  if (!getDatabaseEngineInput("agent")) {
    return;
  }
  const { agentId, assertCurrent } = params;
  await using inspector = createAgentSchemaInspectionWorker();
  for (const target of resolveConfiguredAgentDatabaseTargets(params.config, {
    env: process.env,
    agentId,
  })) {
    if (!statSync(target.path, { throwIfNoEntry: false })?.isFile()) {
      continue;
    }
    const refusal = () =>
      new DuplicateAgentError(
        `Cannot create agent "${agentId}": retained PostgreSQL anchor "${target.path}" has no verified matching initialized namespace. Restore a matching backup with openclaw backup restore <archive> --target <fresh-directory>. If the history is intentionally gone, stop the Gateway, move this anchor and its SQLite sidecars outside the state and agent directories, then retry agents add. See https://docs.openclaw.ai/gateway/postgresql#recover-a-retained-agent-store.`,
      );
    const unverifiable = (reason: unknown, cause: unknown = reason) =>
      new DuplicateAgentError(
        `Cannot create agent "${agentId}": could not verify retained PostgreSQL store "${target.path}": ${formatErrorMessage(reason)}. Check that database.postgres.connection reaches the intended server, then retry. If the server is correct and this store's namespace is gone, see https://docs.openclaw.ai/gateway/postgresql#recover-a-retained-agent-store.`,
        cause instanceof Error ? { cause } : undefined,
      );
    assertCurrent?.();
    let inspection: AgentSchemaInspection | null;
    try {
      inspection = await inspector.inspect({
        pathname: target.path,
        agentId,
        env: process.env,
        supportedVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
        inspectOwnership: true,
      });
    } catch (error) {
      throw unverifiable(error);
    }
    assertCurrent?.();
    // A file without an engine anchor still belongs to ordinary fresh creation.
    if (!inspection) {
      continue;
    }
    // Failed inspection cannot establish that retained history is gone.
    if (inspection.failure || inspection.reason !== undefined) {
      throw unverifiable(inspection.reason || inspection.failure, inspection.failure);
    }
    if (
      inspection.version <= 0 ||
      inspection.version > OPENCLAW_AGENT_SCHEMA_VERSION ||
      inspection.agentSchemaMeta?.agentId !== agentId ||
      inspection.agentSchemaMeta.role !== "agent" ||
      inspection.agentSchemaMeta.schemaVersion !== inspection.version
    ) {
      throw refusal();
    }
  }
}
