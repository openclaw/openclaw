import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { CyberAccessProgram } from "../../packages/gateway-protocol/src/schema/sessions-row.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ModelAuthAvailabilityEvaluation } from "./model-auth-availability.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "./model-catalog.types.js";
import { resolveConfiguredCyberAccessProgram } from "./model-extra-params.js";
import { modelMatchesProviderModelRoute } from "./provider-model-route.js";

/** Missing metadata is unknown. Neither model presence nor auth type grants a program. */
export function resolveModelCatalogAccessPrograms(params: {
  snapshot: ModelCatalogSnapshot;
  entry: Pick<ModelCatalogEntry, "provider" | "id">;
  evaluation: ModelAuthAvailabilityEvaluation;
  runtimeId: string;
  isCurrent: () => boolean;
}): CyberAccessProgram[] | undefined {
  const { snapshot, entry, evaluation, runtimeId } = params;
  if (
    !params.isCurrent() ||
    evaluation.availability !== true ||
    snapshot.refreshFailed ||
    snapshot.pendingProviders?.some(
      (provider) => normalizeProviderId(provider) === normalizeProviderId(entry.provider),
    )
  ) {
    return undefined;
  }
  const native =
    evaluation.runtimeAuth?.id === runtimeId && evaluation.runtimeAuth.source === "native";
  const credential = evaluation.selectedCredential;
  const route = evaluation.selectedRoute;
  if (
    !native &&
    (!credential ||
      credential.source === "harness" ||
      !route ||
      route.requestTransportOverrides === "present")
  ) {
    return undefined;
  }
  const outcomes = native
    ? snapshot.nativeProviderOutcomes?.[runtimeId]
    : snapshot.providerOutcomes;
  const outcome = outcomes?.find(
    (candidate) =>
      normalizeProviderId(candidate.provider) === normalizeProviderId(entry.provider) &&
      (native ||
        (credential?.source === "profile"
          ? candidate.profileId === credential.profileId
          : credential?.source === "direct" && candidate.profileId === undefined)),
  );
  if (outcome?.status !== "ready") {
    return undefined;
  }
  const observation = outcome.modelAccessPrograms?.find(
    (candidate) =>
      candidate.modelId === entry.id &&
      candidate.runtimeId === runtimeId &&
      (native ||
        (route &&
          candidate.api !== undefined &&
          candidate.baseUrl !== undefined &&
          modelMatchesProviderModelRoute({
            provider: entry.provider,
            api: candidate.api,
            baseUrl: candidate.baseUrl,
            route,
          }))),
  );
  return observation ? [...observation.cyber] : undefined;
}

/** One default selection for catalog presentation and physical runtime requests. */
export function resolveModelCyberAccessProgramDefault(params: {
  config?: OpenClawConfig;
  agentId?: string;
  provider: string;
  modelId: string;
  runtimeId: string;
  route?: ModelAuthAvailabilityEvaluation["selectedRoute"];
}): CyberAccessProgram | undefined {
  const { provider, modelId, runtimeId, route } = params;
  const consumesAccessPrograms =
    normalizeProviderId(provider) === "openai" &&
    (runtimeId === "codex" ||
      (runtimeId === "openclaw" &&
        route !== undefined &&
        (route.api === "openai-responses" || route.api === "openai-chatgpt-responses") &&
        modelMatchesProviderModelRoute({
          provider,
          api: route.api,
          baseUrl: route.baseUrl,
          route: {
            ...route,
            baseUrl:
              route.api === "openai-responses"
                ? "https://api.openai.com/v1"
                : "https://chatgpt.com/backend-api/codex",
          },
        })));
  return consumesAccessPrograms
    ? resolveConfiguredCyberAccessProgram(
        {
          config: params.config,
          agentId: params.agentId,
          provider,
          modelId,
        },
        "standard",
      )
    : undefined;
}

// OpenAI models, including the Codex provider ids its plugin owns.
const OPENAI_ACCESS_PROGRAM_PROVIDERS = new Set(["openai", "openai-codex", "codex", "codex-cli"]);

/**
 * Daybreak is an OpenAI program. A saved session choice survives model changes so it
 * applies again on an OpenAI model, but any other provider runs that turn as Standard.
 * OpenAI routes keep their explicit entitlement and runtime errors.
 */
export function resolveCyberAccessProgramForProvider(
  program: CyberAccessProgram | undefined,
  provider: string,
): { program: CyberAccessProgram | undefined; notApplied?: CyberAccessProgram } {
  return program === undefined ||
    program === "standard" ||
    OPENAI_ACCESS_PROGRAM_PROVIDERS.has(normalizeProviderId(provider))
    ? { program }
    : { program: "standard", notApplied: program };
}

const CYBER_ACCESS_PROGRAM_NOTICE_LIMIT = 1_000;
const claimedCyberAccessProgramNotices = new Set<string>();

/** One notice per scope, program, and model per process; a restart may repeat it once. */
function claimCyberAccessProgramNotice(key: string): boolean {
  if (claimedCyberAccessProgramNotices.has(key)) {
    return false;
  }
  if (claimedCyberAccessProgramNotices.size >= CYBER_ACCESS_PROGRAM_NOTICE_LIMIT) {
    claimedCyberAccessProgramNotices.clear();
  }
  claimedCyberAccessProgramNotices.add(key);
  return true;
}

/** Applies a turn's Access to its provider and reports a non-OpenAI downgrade once per scope. */
export function resolveTurnCyberAccessProgram(params: {
  program: CyberAccessProgram | undefined;
  provider: string;
  model: string;
  noticeScope: string;
  notify?: (notice: string) => void;
}): CyberAccessProgram | undefined {
  const { program, notApplied } = resolveCyberAccessProgramForProvider(
    params.program,
    params.provider,
  );
  const model = `${params.provider}/${params.model}`;
  if (
    notApplied &&
    params.notify &&
    claimCyberAccessProgramNotice(`${params.noticeScope}\0${notApplied}\0${model}`)
  ) {
    const label = notApplied === "daybreak_red" ? "Daybreak Red" : "Daybreak Blue";
    params.notify(
      `${label} applies only to OpenAI models, so ${model} used Standard access. Your ${label} choice is kept for when this chat returns to an OpenAI model.`,
    );
  }
  return program;
}

/** The application baseline and configured inheritance do not grant Daybreak entitlement. */
export function projectModelCatalogAccessPrograms(
  params: Parameters<typeof resolveModelCatalogAccessPrograms>[0] & {
    config: OpenClawConfig;
    agentId?: string;
  },
): {
  availableAccessPrograms?: { cyber: CyberAccessProgram[] };
  cyberAccessProgramDefault?: CyberAccessProgram;
} {
  const cyber = resolveModelCatalogAccessPrograms(params);
  const cyberAccessProgramDefault = resolveModelCyberAccessProgramDefault({
    config: params.config,
    agentId: params.agentId,
    provider: params.entry.provider,
    modelId: params.entry.id,
    runtimeId: params.runtimeId,
    route: params.evaluation.selectedRoute,
  });
  return {
    ...(cyber === undefined ? {} : { availableAccessPrograms: { cyber } }),
    ...(cyberAccessProgramDefault === undefined ? {} : { cyberAccessProgramDefault }),
  };
}
