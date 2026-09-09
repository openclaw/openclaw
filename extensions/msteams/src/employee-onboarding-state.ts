// Msteams plugin module persists self-service employee onboarding requests.
import type {
  MSTeamsEmployeeOnboardingRequest,
  MSTeamsEmployeeOnboardingRequestStore,
  MSTeamsEmployeeOnboardingTransitionRequest,
  MSTeamsEmployeeOnboardingTransitionResult,
} from "./employee-onboarding.js";
import { getMSTeamsRuntime } from "./runtime.js";
import {
  resolveMSTeamsSqliteStateEnv,
  toPluginJsonValue,
  withMSTeamsSqliteMutationLock,
} from "./sqlite-state.js";

export const MSTEAMS_EMPLOYEE_ONBOARDING_REQUESTS_NAMESPACE = "employee-onboarding-requests";
const MSTEAMS_MAX_EMPLOYEE_ONBOARDING_REQUESTS = 5000;
const EMPLOYEE_ONBOARDING_MUTATION_KEY = "employee-onboarding-requests";

type MSTeamsEmployeeOnboardingStoreStateOptions = {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  stateDir?: string;
  storePath?: string;
};

function createEmployeeOnboardingRequestStateStore(
  params?: MSTeamsEmployeeOnboardingStoreStateOptions,
) {
  return getMSTeamsRuntime().state.openKeyedStore<MSTeamsEmployeeOnboardingRequest>({
    namespace: MSTEAMS_EMPLOYEE_ONBOARDING_REQUESTS_NAMESPACE,
    maxEntries: MSTEAMS_MAX_EMPLOYEE_ONBOARDING_REQUESTS,
    env: resolveMSTeamsSqliteStateEnv(params),
  });
}

function sameTransition(
  request: MSTeamsEmployeeOnboardingRequest,
  transition: MSTeamsEmployeeOnboardingTransitionRequest,
): boolean {
  return (
    request.status === transition.status &&
    request.transitionedAt === transition.transitionedAt &&
    request.transitionReason === transition.transitionReason &&
    request.failureCode === transition.failureCode &&
    JSON.stringify(request.transitionEvidence) === JSON.stringify(transition.transitionEvidence)
  );
}

async function transitionEmployeeOnboardingRequest(
  params: MSTeamsEmployeeOnboardingStoreStateOptions | undefined,
  requestStore: ReturnType<typeof createEmployeeOnboardingRequestStateStore>,
  requestId: string,
  transition: MSTeamsEmployeeOnboardingTransitionRequest,
): Promise<MSTeamsEmployeeOnboardingTransitionResult> {
  return await withMSTeamsSqliteMutationLock(
    params,
    `${EMPLOYEE_ONBOARDING_MUTATION_KEY}:${requestId}`,
    async () => {
      const existing = await requestStore.lookup(requestId);
      if (!existing) {
        return {
          status: "blocked",
          reason: "missing-request",
          message: "Teams employee onboarding request was not found.",
          sideEffects: [],
        };
      }
      if (existing.status !== "pending") {
        if (sameTransition(existing, transition)) {
          return {
            status: "idempotent",
            request: existing,
            sideEffects: ["employee-onboarding-request-transition"],
          };
        }
        return {
          status: "blocked",
          reason:
            existing.status === transition.status
              ? "conflicting-transition"
              : "request-not-pending",
          message:
            existing.status === transition.status
              ? "Teams employee onboarding request already has different transition evidence."
              : `Teams employee onboarding request is already ${existing.status}.`,
          request: existing,
          sideEffects: [],
        };
      }

      const updated: MSTeamsEmployeeOnboardingRequest = {
        ...existing,
        status: transition.status,
        transitionedAt: transition.transitionedAt ?? new Date().toISOString(),
        ...(transition.transitionReason ? { transitionReason: transition.transitionReason } : {}),
        transitionEvidence: transition.transitionEvidence,
        ...(transition.failureCode ? { failureCode: transition.failureCode } : {}),
      };
      await requestStore.register(requestId, toPluginJsonValue(updated));
      return {
        status: "transitioned",
        request: updated,
        sideEffects: ["employee-onboarding-request-transition"],
      };
    },
  );
}

export function createMSTeamsEmployeeOnboardingRequestStoreState(
  params?: MSTeamsEmployeeOnboardingStoreStateOptions,
): MSTeamsEmployeeOnboardingRequestStore {
  const requestStore = createEmployeeOnboardingRequestStateStore(params);

  return {
    upsertRequest: async (request) =>
      await withMSTeamsSqliteMutationLock(
        params,
        `${EMPLOYEE_ONBOARDING_MUTATION_KEY}:${request.id}`,
        async () => {
          const existing = await requestStore.lookup(request.id);
          if (existing) {
            return { request: existing, created: false };
          }
          await requestStore.register(request.id, toPluginJsonValue(request));
          return { request, created: true };
        },
      ),
    getRequest: async (requestId) => (await requestStore.lookup(requestId)) ?? null,
    listRequests: async () => (await requestStore.entries()).map((entry) => entry.value),
    transitionRequest: async (requestId, transition) =>
      await transitionEmployeeOnboardingRequest(params, requestStore, requestId, transition),
  };
}
