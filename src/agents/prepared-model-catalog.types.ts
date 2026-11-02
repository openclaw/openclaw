import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import type { PreparedAgentCredentialModes } from "./agent-auth-credential-modes.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";

export type PublishedModelCatalogOwnerCandidate = Readonly<{
  /** Captured during preparation; undefined is a known-unbound runtime. */
  catalogOwner: Readonly<{ agentId: string; workspaceDir: string }> | undefined;
  agentId?: string;
  agentDir: string;
  workspaceDir?: string;
  config: OpenClawConfig;
  /** Native observations retain preparation identity across model-neutral config publications. */
  observationConfig: OpenClawConfig;
  /** Secret-free usable auth modes captured by this exact lifecycle generation. */
  authModes: PreparedAgentCredentialModes;
  authStore?: AuthProfileStore;
  metadataSnapshot: PluginMetadataSnapshot;
  /** Registry owned by this prepared generation; omitted from read-only builds. */
  pluginRegistry?: PluginRegistry;
  /** Reports whether this exact lifecycle generation is still published. */
  isCurrent: () => boolean;
  /** Configured turn facts; full inventory discovery stays outside startup publication. */
  modelCatalog: ModelCatalogSnapshot;
  accountCatalog?: import("./prepared-model-runtime-auth.js").PreparedAccountCatalogAccess;
}>;

export type ResolvedPublishedModelCatalogOwner = Readonly<
  PublishedModelCatalogOwnerCandidate & {
    catalogOwner: NonNullable<PublishedModelCatalogOwnerCandidate["catalogOwner"]>;
    agentId: string;
    workspaceDir: string;
    authStore: AuthProfileStore;
  }
>;
