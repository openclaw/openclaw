/**
 * Process-local state for warmed provider auth snapshots.
 */
import { isRecord } from "@openclaw/normalization-core/record-coerce";

export type PreparedProviderAuthState = {
  agentId: string;
  configFingerprint: string;
  providers: ReadonlyMap<string, boolean>;
  defaultModelRoute?: {
    provider: string;
    modelId: string;
    available: boolean;
  };
};

export type ProviderAuthWarmSnapshot = {
  agents: Array<{
    agentId: string;
    configFingerprint: string;
    providers: Array<[string, boolean]>;
    defaultModelRoute?: {
      provider: string;
      modelId: string;
      available: boolean;
    };
  }>;
};

// One entry per configured agent, keyed by agentId. Populated by the provider
// auth warm path; consulted by hasAuthForModelProvider on every model-listing call.
let currentProviderAuthStates: ReadonlyMap<string, PreparedProviderAuthState> | null = null;

// Generation counter guards against an in-flight warm publishing stale state
// after a subsequent warm or clear has invalidated it.
let currentProviderAuthStateGeneration = 0;
let currentProviderAuthWarmWorker: AbortController | undefined;

export function getCurrentProviderAuthStates(): ReadonlyMap<
  string,
  PreparedProviderAuthState
> | null {
  return currentProviderAuthStates;
}

export function claimCurrentProviderAuthStateGeneration(): number {
  currentProviderAuthStateGeneration += 1;
  return currentProviderAuthStateGeneration;
}

export function isCurrentProviderAuthStateGeneration(generation: number): boolean {
  return generation === currentProviderAuthStateGeneration;
}

export function setCurrentProviderAuthWarmWorker(handle: AbortController): void {
  currentProviderAuthWarmWorker = handle;
}

export function clearCurrentProviderAuthWarmWorker(handle: AbortController): void {
  if (currentProviderAuthWarmWorker === handle) {
    currentProviderAuthWarmWorker = undefined;
  }
}

export function cancelCurrentProviderAuthWarmWorker(): void {
  const current = currentProviderAuthWarmWorker;
  if (!current) {
    return;
  }
  currentProviderAuthWarmWorker = undefined;
  current.abort();
}

export function clearCurrentProviderAuthState(): void {
  currentProviderAuthStates = null;
  claimCurrentProviderAuthStateGeneration();
  cancelCurrentProviderAuthWarmWorker();
}

export function publishProviderAuthWarmSnapshot(snapshot: ProviderAuthWarmSnapshot): void {
  currentProviderAuthStates = new Map(
    snapshot.agents.map((state) => [
      state.agentId,
      {
        agentId: state.agentId,
        configFingerprint: state.configFingerprint,
        providers: new Map(state.providers),
        ...(state.defaultModelRoute ? { defaultModelRoute: { ...state.defaultModelRoute } } : {}),
      },
    ]),
  );
}

export function serializeProviderAuthStates(
  states: ReadonlyMap<string, PreparedProviderAuthState>,
): ProviderAuthWarmSnapshot {
  return {
    agents: [...states.values()].map((state) => {
      const serialized: ProviderAuthWarmSnapshot["agents"][number] = {
        agentId: state.agentId,
        configFingerprint: state.configFingerprint,
        providers: [...state.providers.entries()],
      };
      if (state.defaultModelRoute) {
        serialized.defaultModelRoute = state.defaultModelRoute;
      }
      return serialized;
    }),
  };
}

export function isProviderAuthWarmSnapshot(value: unknown): value is ProviderAuthWarmSnapshot {
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray((value as { agents?: unknown }).agents)
  ) {
    return false;
  }
  return (value as { agents: unknown[] }).agents.every(
    (agent) =>
      isRecord(agent) &&
      typeof agent.agentId === "string" &&
      typeof agent.configFingerprint === "string" &&
      Array.isArray(agent.providers) &&
      agent.providers.every(
        (entry) =>
          Array.isArray(entry) &&
          entry.length === 2 &&
          typeof entry[0] === "string" &&
          typeof entry[1] === "boolean",
      ) &&
      (agent.defaultModelRoute === undefined ||
        (isRecord(agent.defaultModelRoute) &&
          typeof agent.defaultModelRoute.provider === "string" &&
          typeof agent.defaultModelRoute.modelId === "string" &&
          typeof agent.defaultModelRoute.available === "boolean")),
  );
}
