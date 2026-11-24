import { stat } from "node:fs/promises";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { ignoreMissingPath } from "../infra/errno.js";
import { resolveIdentityPathViaExistingAncestor } from "../infra/path-existence.js";
import { runOpenClawAgentWriteAdmissions } from "../state/openclaw-agent-write-admission.js";
import { captureOpenClawStateReadWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { withPluginModelCatalogWorker } from "./plugin-model-catalog-execution.js";
import type { PluginModelCatalogCredentialCandidate } from "./plugin-model-catalog-read.worker.js";

/** Inspect candidates together; only changed catalogs need their canonical agent writer. */
export async function removePersistedPluginModelCatalogCredentials(params: {
  candidates: readonly PluginModelCatalogCredentialCandidate[];
  credentials: ReadonlySet<string>;
}): Promise<void> {
  if (params.candidates.length === 0 || params.credentials.size === 0) {
    return;
  }
  const credentials = [...params.credentials];
  const env = cloneEnvWithPlatformSemantics(process.env);
  const capturedCandidates = await Promise.all(
    params.candidates.map(async ({ agentId, databasePath }) => ({
      agentId,
      databasePath: await resolveIdentityPathViaExistingAncestor(databasePath),
    })),
  );
  const candidates: PluginModelCatalogCredentialCandidate[] = [];
  for (const candidate of capturedCandidates) {
    if (!(await stat(candidate.databasePath).catch(ignoreMissingPath))) {
      continue;
    }
    candidates.push(candidate);
  }
  if (candidates.length === 0) {
    return;
  }
  const context = captureOpenClawStateReadWorkerContext({ env });
  const requiringCleanup = await runOpenClawAgentWriteAdmissions(
    candidates.map(({ agentId, databasePath }) => ({ agentId, path: databasePath, env })),
    async () => {
      // Auth removal precedes this barrier. Earlier publications must commit before
      // the read; later publications revalidate the removed auth before writing.
      const result = await runOpenClawStateWorkerOperation(
        context,
        (scope) =>
          scope.execute({
            type: "pluginModelCatalogCredentials.candidates",
            input: { candidates, credentials },
          }),
        { existingOnly: true },
      );
      context.admission.assertCurrent();
      return result;
    },
  );
  // Release the read barrier before entering each canonical writer.
  for (const candidate of requiringCleanup ?? candidates) {
    await withPluginModelCatalogWorker(
      { agentId: candidate.agentId, path: candidate.databasePath, env },
      false,
      async (scope) => {
        await scope.execute({ type: "catalog.removeCredentials", input: { credentials } });
      },
    );
  }
}
