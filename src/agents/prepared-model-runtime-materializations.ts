import {
  getPreparedRuntimeAuthMaterializations,
  registerRuntimeAuthMaterializationMutationListener,
} from "./auth-profiles/runtime-materializations.js";
import { bindPreparedModelRuntimeAuth } from "./prepared-model-runtime-auth.js";
import {
  normalizeOptionalDir,
  type PreparedModelRuntimeOwner,
} from "./prepared-model-runtime.owner.js";

export function configuredOwnersAreRequestVisible(
  owners: ReadonlyMap<string, PreparedModelRuntimeOwner>,
): boolean {
  for (const owner of owners.values()) {
    if (owner.provenance !== "configured") {
      continue;
    }
    if (!owner.snapshot || owner.needsRefresh || owner.pending) {
      return false;
    }
  }
  return true;
}

export function registerPreparedRuntimeAuthMaterializationPublisher(
  owners: ReadonlyMap<string, PreparedModelRuntimeOwner>,
  notify: (event: { phase: "invalidated" | "published"; modelFactsChanged: false }) => void,
): () => void {
  return registerRuntimeAuthMaterializationMutationListener((event) => {
    const agentDir = normalizeOptionalDir(event.agentDir);
    const affectedOwners = [...owners.values()].flatMap((owner) => {
      const affected =
        event.affectsInheritedStores ||
        owner.input.agentDir === agentDir ||
        owner.input.inheritedAuthDir === agentDir;
      return affected && owner.snapshot && !owner.pending && !owner.needsRefresh
        ? [{ owner, snapshot: owner.snapshot }]
        : [];
    });
    if (affectedOwners.length === 0) {
      return;
    }
    for (const { owner, snapshot } of affectedOwners) {
      // A successful route only changes this bounded secret-free fact set. Rebuilding the model
      // catalog here would pull plugin lifecycle work into the turn-completion boundary.
      bindPreparedModelRuntimeAuth(snapshot, {
        materializations: Object.freeze([
          ...getPreparedRuntimeAuthMaterializations(owner.input.agentDir),
        ]),
      });
    }
    // Chat metadata treats published as "every configured owner is capturable".
    // A bind on one agent must not announce while a sibling is stale or a replacement
    // still holds needsRefresh; that refresh fail-closes the Control UI picker.
    if (!configuredOwnersAreRequestVisible(owners)) {
      return;
    }
    notify({ phase: "invalidated", modelFactsChanged: false });
    notify({ phase: "published", modelFactsChanged: false });
  });
}
