import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { modelKey } from "./model-ref-shared.js";

/** Bind runtime selection and its commit check to the current published model owner. */
export async function preparePublishedModelRuntimeChoice(params: {
  cfg: OpenClawConfig;
  agentId: string;
  workspaceDir?: string;
  provider: string;
  model: string;
  runtimeId: string;
  sessionEntry?: Pick<
    SessionEntry,
    "authProfileOverride" | "authProfileOverrideSource" | "providerOverride" | "modelProvider"
  >;
}): Promise<
  { kind: "unavailable"; message: string } | { kind: "ready"; validate: () => string | undefined }
> {
  const { getPublishedPreparedModelCatalogOwnerSnapshot, materializePreparedModelCatalogOwner } =
    await import("./prepared-model-catalog.js");
  const { getPreparedModelRuntimeAuthStore } = await import("./prepared-model-runtime-auth.js");
  const { createModelCatalogDecisions } = await import("./model-catalog-decisions.js");
  const published = getPublishedPreparedModelCatalogOwnerSnapshot({
    config: params.cfg,
    agentId: params.agentId,
    workspaceDir: params.workspaceDir,
  });
  const unavailable = `Runtime "${params.runtimeId}" is not available for ${params.provider}/${params.model}. Refresh the model catalog and choose again.`;
  if (!published) {
    return { kind: "unavailable", message: unavailable };
  }
  const owner = materializePreparedModelCatalogOwner(published);
  const authStore = getPreparedModelRuntimeAuthStore(owner);
  if (!authStore) {
    return { kind: "unavailable", message: unavailable };
  }
  const decisions = createModelCatalogDecisions({
    cfg: owner.config,
    agentId: owner.agentId ?? params.agentId,
    agentDir: owner.agentDir,
    workspaceDir: owner.workspaceDir,
    snapshot: owner.modelCatalog,
    metadataSnapshot: owner.metadataSnapshot,
    preparedAuthStore: authStore,
    preparedRuntimeAuthModes: owner.authModes,
    pluginRegistry: owner.pluginRegistry,
    observationConfig: owner.observationConfig,
    isCurrent: owner.isCurrent,
    preferredProfileId: params.sessionEntry?.authProfileOverride,
    pinnedProfileId:
      params.sessionEntry?.authProfileOverrideSource === "user"
        ? params.sessionEntry.authProfileOverride
        : undefined,
    profileProvider: params.sessionEntry?.providerOverride ?? params.sessionEntry?.modelProvider,
  });
  const entry = decisions.snapshot.entries.find(
    (row) => modelKey(row.provider, row.id) === modelKey(params.provider, params.model),
  );
  if (!entry) {
    return { kind: "unavailable", message: unavailable };
  }
  const variants = decisions.snapshot.routeVariants.filter(
    (row) => modelKey(row.provider, row.id) === modelKey(entry.provider, entry.id),
  );
  const choices = await decisions.runtimeChoices(entry, variants.length ? variants : [entry]);
  if (!choices?.includes(params.runtimeId)) {
    return { kind: "unavailable", message: unavailable };
  }
  const host = await decisions.evaluateEntry(
    entry,
    variants.length ? variants : [entry],
    params.runtimeId,
  );
  const validate = () =>
    decisions.isCurrent() &&
    decisions.evaluateNative(entry, host, params.runtimeId).availability === true
      ? undefined
      : unavailable;

  return { kind: "ready", validate };
}
