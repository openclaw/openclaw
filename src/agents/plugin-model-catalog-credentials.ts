import { stat } from "node:fs/promises";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { resolvePathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { hasErrnoCode } from "../infra/errno.js";
import { captureOpenClawStateReadWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import {
  withPluginModelCatalogPublicationLocks,
  withPluginModelCatalogWorker,
} from "./plugin-model-catalog-execution.js";
import type { PluginModelCatalogCredentialCandidate } from "./plugin-model-catalog-read.worker.js";

/** Inspect candidates together; only changed catalogs need their canonical agent writer. */
export async function removePersistedPluginModelCatalogCredentials(params: {
  candidates: readonly PluginModelCatalogCredentialCandidate[];
  credentials: ReadonlySet<string>;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  if (params.candidates.length === 0 || params.credentials.size === 0) {
    return;
  }
  const credentials = [...params.credentials];
  const env = cloneEnvWithPlatformSemantics(params.env ?? process.env);
  const capturedCandidates = params.candidates.map(({ agentId, databasePath }) => ({
    agentId,
    databasePath: resolvePathViaExistingAncestorSync(databasePath),
  }));
  const candidates: PluginModelCatalogCredentialCandidate[] = [];
  for (const candidate of capturedCandidates) {
    try {
      await stat(candidate.databasePath);
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT")) {
        continue;
      }
      throw error;
    }
    candidates.push(candidate);
  }
  if (candidates.length === 0) {
    return;
  }
  const context = captureOpenClawStateReadWorkerContext({ env });
  await withPluginModelCatalogPublicationLocks(
    candidates.map(({ databasePath }) => databasePath),
    async () => {
      // Auth removal precedes this barrier. Earlier publications must commit before
      // the read; later publications revalidate the removed auth before writing.
      const requiringCleanup = await runOpenClawStateWorkerOperation(
        context,
        (scope) =>
          scope.execute({
            type: "pluginModelCatalogCredentials.candidates",
            input: { candidates, credentials },
          }),
        { existingOnly: true },
      );
      context.admission.assertCurrent();
      // Without shared state, preserve the existing writer path without creating a read owner.
      for (const candidate of requiringCleanup ?? candidates) {
        await withPluginModelCatalogWorker(
          { agentId: candidate.agentId, path: candidate.databasePath, env },
          false,
          async (scope) => {
            await scope.execute({ type: "catalog.removeCredentials", input: { credentials } });
          },
        );
      }
    },
  );
}
