/**
 * Execution owner selection for isolated completions. Dispatch and status
 * displays share this decision, so a surface that reports "Claude CLI" or
 * "API" for a utility model cannot drift from the route the completion takes.
 * Kept apart from isolated-completion.ts so readers do not load run machinery.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentDir, resolveAgentWorkspaceDir, resolveDefaultAgentId } from "./agent-scope.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { resolveCliRuntimeCanonicalProvider } from "./cli-backends.js";
import { resolveEmbeddedCliBackendDispatchEligibility } from "./embedded-agent-runner/cli-backend-dispatch-eligibility.js";
import {
  resolveAgentHarnessSelectionDecision,
  type AgentHarnessSelectionDecision,
} from "./harness/selection-decision.js";
import type { ModelCatalogDecisionParams } from "./model-catalog-decisions.js";
import {
  createModelCatalogSnapshotView,
  listModelCatalogObservedRoutes,
} from "./model-catalog-view.js";
import {
  isCliRuntimeAliasForProvider,
  resolveCliRuntimeExecutionProvider,
} from "./model-runtime-aliases.js";
import {
  canRunPreparedAgentRuntimeAuthAttempt,
  prepareAgentRuntimeAuth,
  preparedAgentRuntimeProfileAttemptHasCandidate,
  type PreparedAgentRuntimeAuthAttempt,
} from "./runtime-plan/prepare-auth.js";
import type { AgentRuntimeAuthPlan } from "./runtime-plan/types.js";

export type IsolatedCompletionRouteParams = {
  config?: OpenClawConfig;
  provider: string;
  model: string;
  authProfileId?: string;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  agentHarnessRuntimeOverride?: string;
  preparedAuth?: Pick<
    ModelCatalogDecisionParams,
    "preparedAuthStore" | "metadataSnapshot" | "snapshot"
  >;
};

/** A CLI runtime ref canonicalizes to its model provider but keeps the CLI as its explicit owner. */
export function resolveIsolatedCompletionProvider(params: {
  provider: string;
  config: OpenClawConfig;
  agentHarnessRuntimeOverride?: string;
}): { provider: string; runtimeOverride?: string } {
  const canonicalProvider = resolveCliRuntimeCanonicalProvider({
    runtime: params.provider,
    config: params.config,
    includeSetupRegistry: true,
  });
  const runtimeOverride =
    params.agentHarnessRuntimeOverride ?? (canonicalProvider ? params.provider : undefined);
  return {
    provider: canonicalProvider ?? params.provider,
    ...(runtimeOverride ? { runtimeOverride } : {}),
  };
}

/** Harness selection plus the CLI backend, when one owns this completion instead of a harness. */
export function resolveIsolatedCompletionRoute(params: {
  config: OpenClawConfig;
  /** Canonical model provider from resolveIsolatedCompletionProvider. */
  provider: string;
  model: string;
  authProfileId?: string;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  runtimeOverride?: string;
  /** Only a caller-supplied owner suppresses automatic CLI discovery. */
  explicitRuntimeOverride?: string;
  preparedAuthStore?: AuthProfileStore;
}): { selection: AgentHarnessSelectionDecision; cliOwner?: string } {
  const selection = resolveAgentHarnessSelectionDecision({
    provider: params.provider,
    modelId: params.model,
    config: params.config,
    agentId: params.agentId,
    agentHarnessRuntimeOverride: params.runtimeOverride,
  });
  const runtime = params.runtimeOverride ?? selection.policy.runtime;
  if (isCliRuntimeAliasForProvider({ runtime, provider: params.provider, cfg: params.config })) {
    return { selection, cliOwner: runtime };
  }
  if (params.explicitRuntimeOverride) {
    // An explicit non-CLI owner is authoritative. Automatic CLI discovery must
    // not bypass that harness or turn its unsupported result into a fallback.
    return { selection };
  }
  const cliOwner =
    resolveCliRuntimeExecutionProvider({
      provider: params.provider,
      cfg: params.config,
      agentId: params.agentId,
      modelId: params.model,
      authProfileId: params.authProfileId,
      preparedAuthStore: params.preparedAuthStore,
    }) ??
    resolveEmbeddedCliBackendDispatchEligibility({
      provider: params.provider,
      model: params.model,
      agentId: params.agentId,
      authProfileId: params.authProfileId,
      config: params.config,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      preparedAuthStore: params.preparedAuthStore,
    })?.provider;
  return cliOwner ? { selection, cliOwner } : { selection };
}

/** How an isolated completion reaches its model, for provider-neutral route labels. */
export type IsolatedCompletionRuntime = {
  id: string;
  /** api: built-in HTTP runtime; cli: a CLI backend; harness: a plugin agent harness. */
  kind: "api" | "cli" | "harness";
  /** Display label a plugin harness declares for itself. */
  harnessLabel?: string;
};

/** Scope profile checks and dispatch to the same single physical auth attempt. */
export function selectIsolatedHarnessAuthAttempt(
  attempt: PreparedAgentRuntimeAuthAttempt,
): PreparedAgentRuntimeAuthAttempt {
  if (attempt.kind !== "profile") {
    return attempt;
  }
  return {
    ...attempt,
    plan: {
      ...attempt.plan,
      forwardedAuthProfileId: attempt.profileId,
      // Core owns order; each dispatch receives one exact candidate.
      forwardedAuthProfileCandidateIds: [attempt.profileId],
    },
  };
}

/** The auth planner owns this choice for both dispatch and its read-only projection. */
export function resolveIsolatedCompletionAuthorizationOwner(
  plan: AgentRuntimeAuthPlan | undefined,
) {
  return plan?.harnessAuthProvider && plan.modelRoute?.authRequirement !== "api-key"
    ? ("harness" as const)
    : ("host" as const);
}

/**
 * Planned runtime for an isolated completion in the supplied prepared generation.
 * Undefined when no owner or runnable auth attempt can serve the request.
 */
export function resolveIsolatedCompletionRuntime(
  params: IsolatedCompletionRouteParams,
): IsolatedCompletionRuntime | undefined {
  const config = params.config ?? {};
  try {
    const agentId = params.agentId ?? resolveDefaultAgentId(config);
    const { provider, runtimeOverride } = resolveIsolatedCompletionProvider({
      provider: params.provider,
      config,
      agentHarnessRuntimeOverride: params.agentHarnessRuntimeOverride,
    });
    const route = resolveIsolatedCompletionRoute({
      config,
      provider,
      model: params.model,
      authProfileId: params.authProfileId,
      agentId,
      agentDir: params.agentDir ?? resolveAgentDir(config, agentId),
      workspaceDir: params.workspaceDir ?? resolveAgentWorkspaceDir(config, agentId),
      runtimeOverride,
      explicitRuntimeOverride: params.agentHarnessRuntimeOverride,
      preparedAuthStore: params.preparedAuth?.preparedAuthStore,
    });
    if (route.cliOwner) {
      return { id: route.cliOwner, kind: "cli" };
    }
    const { harness, selectedHarnessId } = route.selection;
    if (!harness) {
      return { id: selectedHarnessId, kind: "api" };
    }
    if (!harness.runIsolatedCompletionV2 && !harness.runIsolatedCompletion) {
      return undefined;
    }
    if (harness.resolveIsolatedCompletionRuntime) {
      let authorizationOwner: "host" | "harness" = "host";
      if (harness.runIsolatedCompletionV2 && harness.authBootstrap === "harness") {
        const prepared = params.preparedAuth;
        if (!prepared) {
          return undefined;
        }
        const variants = createModelCatalogSnapshotView(config, prepared.snapshot).variantsOf({
          provider,
          id: params.model,
        });
        const { attempts } = prepareAgentRuntimeAuth({
          provider,
          modelId: params.model,
          observedRoutes: variants ? listModelCatalogObservedRoutes(variants) : undefined,
          config,
          agentId,
          agentDir: params.agentDir,
          workspaceDir: params.workspaceDir,
          metadataSnapshot: prepared.metadataSnapshot,
          authProfileStore: prepared.preparedAuthStore,
          sessionAuthProfileId: params.authProfileId,
          sessionAuthProfileSource: params.authProfileId ? "user" : undefined,
          ...(params.authProfileId ? { allowAuthProfileFallback: false } : {}),
          harnessId: harness.id,
          harnessRuntime: harness.id,
          harnessAuthBootstrap: harness.authBootstrap,
        });
        const selectedAttempt = attempts.find((candidate) => {
          const attempt = selectIsolatedHarnessAuthAttempt(candidate);
          return (
            canRunPreparedAgentRuntimeAuthAttempt({ attempt, priorProfileAttempted: false }) &&
            (attempt.kind !== "profile" ||
              preparedAgentRuntimeProfileAttemptHasCandidate({
                attempt,
                store: prepared.preparedAuthStore,
                modelId: params.model,
              }))
          );
        });
        if (!selectedAttempt) {
          return undefined;
        }
        authorizationOwner = resolveIsolatedCompletionAuthorizationOwner(selectedAttempt.plan);
      }
      if (harness.resolveIsolatedCompletionRuntime({ authorizationOwner }) === "openclaw") {
        return { id: "openclaw", kind: "api" };
      }
    }
    return { id: selectedHarnessId, kind: "harness", harnessLabel: harness.label };
  } catch {
    // Status displays must not fail their response. Selection throws for a
    // pinned harness that is missing or unsupported; the completion would
    // fail too, so there is no route to report.
    return undefined;
  }
}
