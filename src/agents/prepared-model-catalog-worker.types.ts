import type { captureClawInstallSchemaVersionFacts } from "../claws/provenance-runtime-read.js";
import type { serializeConfigResolutionFacts } from "../config/resolution-facts.js";
import type { Model } from "../llm/types.js";
import type { ActiveRemoteModelCatalog } from "../model-catalog/remote-overlay.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { PreparedSyntheticAuthFacts } from "../plugins/provider-synthetic-auth.js";
import type { AuthProfileStore, SharedAuthStoreOwnership } from "./auth-profiles/types.js";
import type { ModelCatalogAuthLabels } from "./model-catalog-auth-labels.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import type { PreparedModelRuntimeAuth } from "./prepared-model-runtime-auth.js";
import type {
  PreparedModelRuntimeAgentFacts,
  PreparedModelRuntimeCatalogFacts,
} from "./prepared-model-runtime.catalog-contract.js";
import type { PreparedModelRuntimeInput } from "./prepared-model-runtime.types.js";
import type { AuthStorageData } from "./sessions/auth-storage.js";

export type PreparedModelCatalogWorkerInput = Readonly<{
  generationFingerprint: string;
  remoteCatalog: ActiveRemoteModelCatalog | null;
  input: PreparedModelRuntimeInput & { env: NodeJS.ProcessEnv };
  sourceConfigForSecrets: PreparedModelRuntimeInput["config"];
  configResolutionFacts: ReturnType<typeof serializeConfigResolutionFacts>;
  sourceConfigResolutionFacts: ReturnType<typeof serializeConfigResolutionFacts>;
  authStore: AuthProfileStore;
  sharedAuthStoreOwnership?: SharedAuthStoreOwnership;
  providerIds: readonly string[];
  catalogFacts: Pick<
    PreparedModelRuntimeAgentFacts,
    "configuredModelRefs" | "configuredRuntimeModels"
  >;
  preferBuiltPluginArtifacts: boolean;
  pluginMetadataSnapshot: Omit<PluginMetadataSnapshot, "normalizePluginId">;
}>;

export type PreparedModelCatalogWorkerTask = {
  value: PreparedModelCatalogWorkerInput;
  request: PreparedModelWorkerRequest;
};

export type PreparedModelWorkerCommand =
  | Readonly<{ kind: "catalog"; providerIds?: readonly string[]; refresh?: boolean }>
  | Readonly<{
      kind: "auth-refresh";
      profileIds?: readonly string[];
      providerIds: readonly string[];
    }>;

export type PreparedModelWorkerRequest = PreparedModelWorkerCommand &
  Readonly<{
    syntheticAuth: PreparedSyntheticAuthFacts;
    clawInstallSchemaVersions: ReturnType<typeof captureClawInstallSchemaVersionFacts>;
    /** Codex client version decided by the parent; absent means the bundled pin. */
    codexClientVersion?: string;
  }>;

export type PreparedModelWorkerResult =
  | Readonly<
      PreparedModelRuntimeAuth & {
        status: "ok";
        generationFingerprint: string;
        credentials: Readonly<AuthStorageData>;
      } & (
          | {
              kind: "catalog";
              snapshot: ModelCatalogSnapshot;
              runtimeModels: Map<string, Model[]>;
              providerExpiries: Map<string, number>;
              hookRows: Map<string, Set<string>>;
              configuredRuntimeModels: PreparedModelRuntimeCatalogFacts["configuredRuntimeModels"];
              providerAuthLabels: ModelCatalogAuthLabels;
            }
          | { kind: "auth-refresh" }
        )
    >
  | Readonly<{
      status: "generation-mismatch";
      generationFingerprint: string;
      reconstructedFingerprint: string;
    }>
  | Readonly<{ status: "failed"; error: string }>;
