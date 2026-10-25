import { isDeepStrictEqual } from "node:util";
import { FailoverError } from "../../failover-error.js";
import { resolveSelectedModelCredential } from "../../model-auth-selected-credential.js";
import { resolveModelCatalogAccessPrograms } from "../../model-catalog-access-programs.js";
import { getPreparedModelFullCatalogAuth } from "../../prepared-model-runtime-auth.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

/** Session overrides need current account evidence; model configuration remains explicit policy. */
export async function prepareEmbeddedAccessProgramGuard(
  attempt: EmbeddedRunAttemptParams,
): Promise<(() => void) | undefined> {
  const program = attempt.cyberAccessProgram;
  if (program === undefined || program === "standard") {
    return undefined;
  }
  const runtime = attempt.preparedModelRuntime;
  const profileId = attempt.authProfileId;
  const credential = profileId ? attempt.authProfileStore?.profiles[profileId] : undefined;
  const selectedCredential = resolveSelectedModelCredential({
    provider: attempt.provider,
    profileId,
    mode: credential?.type ?? attempt.runtimePlan?.auth.selectedAuthMode,
  });
  const account =
    runtime?.accountCatalog && profileId && credential
      ? await runtime.accountCatalog.acquire({
          profileId,
          credential,
          allowDiscovery: false,
          load: async () => [],
        })
      : undefined;
  const check = () => {
    const snapshot = runtime?.readFullModelCatalog?.() ?? runtime?.modelCatalog;
    // A cold private catalog can reuse shared discovery only for the same credential.
    // A published empty private catalog is authoritative and must not fall back.
    const providerOutcomes = account?.hasPublishedCatalog
      ? account.outcomes
      : snapshot &&
          profileId &&
          credential &&
          isDeepStrictEqual(
            getPreparedModelFullCatalogAuth(snapshot)?.authStore.profiles[profileId],
            credential,
          )
        ? snapshot.providerOutcomes
        : [];
    const programs =
      snapshot &&
      resolveModelCatalogAccessPrograms({
        snapshot: { ...snapshot, providerOutcomes },
        entry: { provider: attempt.provider, id: attempt.modelId },
        evaluation: {
          availability: true,
          routeResolution: null,
          selectedCredential,
          selectedRoute: attempt.runtimePlan?.auth.modelRoute,
        },
        runtimeId: "openclaw",
        isCurrent: () => runtime?.isCurrent() === true && account?.isCurrent() !== false,
      });
    if (!programs?.includes(program)) {
      throw new FailoverError(
        "This Daybreak program is not advertised for the current account, model, and runtime. Reset Access to the model default or refresh account capabilities.",
        {
          // A stale session choice says nothing about shared credential health.
          reason: "format",
          provider: attempt.provider,
          model: attempt.modelId,
          code: "OPENAI_ACCESS_PROGRAM_UNAVAILABLE",
        },
      );
    }
  };
  check();
  return check;
}
