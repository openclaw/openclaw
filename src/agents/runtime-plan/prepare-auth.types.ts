import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  ProviderModelRouteSource,
  ProviderResolveModelRoutesContext,
  ProviderRouteOverridePresence,
} from "../../plugin-sdk/provider-model-types.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import type { ProviderResolveAuthProfileIdContext } from "../../plugins/provider-runtime.types.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";

// Preparation consumes concrete config/plugin inputs; the prepared plan stays a leaf contract.
export type PrepareAgentRuntimeAuthPlanParams = {
  provider: string;
  modelId: string;
  modelApi?: string | null;
  modelBaseUrl?: unknown;
  /** Physical catalog rows for the logical model; replaces the single api/baseUrl observation. */
  observedRoutes?: readonly ProviderModelRouteSource[];
  requestTransportOverrides?: ProviderRouteOverridePresence;
  config?: OpenClawConfig;
  agentId?: string;
  routeIntent?: ProviderResolveModelRoutesContext["routeIntent"];
  env?: NodeJS.ProcessEnv;
  agentDir?: string;
  workspaceDir?: string;
  metadataSnapshot?: PluginMetadataSnapshot;
  authProfileStore?: AuthProfileStore;
  sessionAuthProfileId?: string;
  /** Required by a durable caller, without turning automatic selection into a user pin. */
  requiredAuthProfileId?: string;
  sessionAuthProfileSource?: "auto" | "user" | "user-link";
  allowAuthProfileFallback?: boolean;
  harnessId?: string;
  harnessRuntime?: string;
  harnessAuthBootstrap?: "harness";
  allowHarnessAuthProfileForwarding?: boolean;
  allowTransientCooldownProbe?: boolean;
  resolveProviderPreferredProfileId?(
    context: ProviderResolveAuthProfileIdContext,
  ): string | undefined;
};
