import type { PreparedModelRuntimeCatalogAccessParams } from "./prepared-model-runtime.catalog-contract.js";
import { PreparedModelCatalogGenerationMismatchError } from "./prepared-model-runtime.errors.js";
import { resolvePreparedModelRuntimeOwnerBySnapshot } from "./prepared-model-runtime.owner-registry.js";

export function createPreparedModelCatalogGenerationRecoveryHandler(
  params: Pick<PreparedModelRuntimeCatalogAccessParams, "agentFacts" | "inventoryOwner">,
): (error: Error) => void {
  return (error) => {
    if (
      !(error instanceof PreparedModelCatalogGenerationMismatchError) ||
      error.agentDir !== params.agentFacts.input.agentDir ||
      params.inventoryOwner.provenance !== "configured" ||
      !params.inventoryOwner.snapshot
    ) {
      return;
    }
    const snapshot = params.inventoryOwner.snapshot;
    const owner = resolvePreparedModelRuntimeOwnerBySnapshot(snapshot);
    if (!owner || owner.provenance !== "configured") {
      return;
    }
    const generation = owner.generation;
    void import("./prepared-model-runtime.catalog-recovery-runtime.js")
      .then(async ({ replacePreparedModelRuntimeOwnedSnapshotAtRuntime }) => {
        await replacePreparedModelRuntimeOwnedSnapshotAtRuntime({ owner, generation, snapshot });
      })
      .catch((recoveryError: unknown) => {
        process.emitWarning(
          `Prepared model catalog generation recovery failed: ${String(recoveryError)}`,
        );
      });
  };
}
