import { isDeepStrictEqual } from "node:util";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { CyberAccessProgram } from "../../../../packages/gateway-protocol/src/schema/sessions-row.js";
import type { ProviderPlugin } from "../../../plugins/types.js";
import {
  assertOperatorAccessProgramAllowed,
  readRunOperatorAuthority,
} from "../../admitted-run-context.js";
import type { AuthProfileCredential } from "../../auth-profiles/types.js";
import { FailoverError } from "../../failover-error.js";
import { resolveAgentHarnessPreparedAuthSupport } from "../../harness/support.js";
import { resolveSelectedModelCredential } from "../../model-auth-selected-credential.js";
import {
  consumesCyberAccessPrograms,
  resolveModelCatalogAccessPrograms,
} from "../../model-catalog-access-programs.js";
import { getPreparedModelFullCatalogAuth } from "../../prepared-model-runtime-auth.js";
import type { AgentRuntimeAuthPlan } from "../../runtime-plan/types.js";
import type { PreparedEmbeddedAttemptDispatchInput } from "./execution-context.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

const accessProgramLabels = {
  standard: "Standard",
  daybreak_blue: "Daybreak Blue",
  daybreak_red: "Daybreak Red",
} as const;

// OAuth refresh rotates tokens without changing the account that discovery observed.
// The provider owns account-and-user identity; workspace ids or optional emails are not enough.
function isSameDiscoveredAccount(
  discovered: AuthProfileCredential | undefined,
  credential: AuthProfileCredential,
  provider: ProviderPlugin | undefined,
): boolean {
  if (isDeepStrictEqual(discovered, credential)) {
    return true;
  }
  if (discovered?.type !== "oauth" || credential.type !== "oauth") {
    return false;
  }
  return (
    discovered.provider === credential.provider &&
    discovered.enterpriseUrl === credential.enterpriseUrl &&
    discovered.issuer === credential.issuer &&
    discovered.clientId === credential.clientId &&
    discovered.authFlow === credential.authFlow &&
    provider?.auth.some((method) => method.matchesPersonalAccount?.(credential, discovered)) ===
      true
  );
}

/**
 * Reads the programs the prepared catalog advertises for one attempt's account, model, route,
 * and runtime. Harness-owned auth reads that runtime's native observations.
 */
async function prepareAttemptAccessPrograms(
  attempt: Pick<
    EmbeddedRunAttemptParams,
    "preparedModelRuntime" | "authProfileId" | "authProfileStore" | "provider" | "modelId"
  > & { auth?: AgentRuntimeAuthPlan; runtimeId: string },
): Promise<() => CyberAccessProgram[] | undefined> {
  const runtime = attempt.preparedModelRuntime;
  const profileId = attempt.authProfileId;
  const credential = profileId ? attempt.authProfileStore?.profiles[profileId] : undefined;
  const runtimeAuth =
    resolveAgentHarnessPreparedAuthSupport({ plan: attempt.auth })?.source === "harness"
      ? { id: attempt.runtimeId, source: "native" as const }
      : undefined;
  const selectedCredential = resolveSelectedModelCredential({
    provider: attempt.provider,
    profileId,
    mode: credential?.type ?? attempt.auth?.selectedAuthMode,
    runtimeAuth,
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
  return () => {
    const snapshot = runtime?.readFullModelCatalog?.() ?? runtime?.modelCatalog;
    // Direct discovery belongs to the current prepared runtime generation.
    // A cold private catalog can reuse shared discovery only for the same account.
    // A published empty private catalog is authoritative and must not fall back.
    const providerOutcomes =
      selectedCredential?.source === "direct"
        ? (snapshot?.providerOutcomes ?? [])
        : account?.hasPublishedCatalog
          ? account.outcomes
          : snapshot &&
              profileId &&
              credential &&
              isSameDiscoveredAccount(
                getPreparedModelFullCatalogAuth(snapshot)?.authStore.profiles[profileId],
                credential,
                runtime?.pluginRegistry?.providers.find(
                  ({ provider }) => provider.id === attempt.provider,
                )?.provider,
              )
            ? snapshot.providerOutcomes
            : [];
    return snapshot
      ? resolveModelCatalogAccessPrograms({
          snapshot: { ...snapshot, providerOutcomes },
          entry: { provider: attempt.provider, id: attempt.modelId },
          evaluation: {
            availability: true,
            routeResolution: null,
            selectedCredential,
            selectedRoute: attempt.auth?.modelRoute,
            ...(runtimeAuth ? { runtimeAuth } : {}),
          },
          runtimeId: attempt.runtimeId,
          isCurrent: () => runtime?.isCurrent() === true && account?.isCurrent() !== false,
        })
      : undefined;
  };
}

/**
 * Programs for one dispatch's Access default, read only for routes that send a program. A saved
 * session choice replaces the default, and a superseded prepared runtime leaves programs unknown.
 */
export async function readDispatchAccessPrograms(
  input: {
    runInput: Pick<PreparedEmbeddedAttemptDispatchInput["runInput"], "preparedModelRuntime">;
    preparedRuntime: Pick<
      PreparedEmbeddedAttemptDispatchInput["preparedRuntime"],
      "provider" | "modelId" | "resolveRunAttemptAuthProfileStore"
    >;
  },
  runtime: Pick<
    ReturnType<PreparedEmbeddedAttemptDispatchInput["preparedRuntime"]["snapshot"]>,
    "activePreparedAuthPlan" | "lastProfileId"
  > & {
    agentHarness: Pick<
      ReturnType<
        PreparedEmbeddedAttemptDispatchInput["preparedRuntime"]["snapshot"]
      >["agentHarness"],
      "id"
    >;
  },
  program: CyberAccessProgram | undefined,
): Promise<CyberAccessProgram[] | undefined> {
  const { preparedModelRuntime } = input.runInput;
  const { provider, modelId } = input.preparedRuntime;
  const auth = runtime.activePreparedAuthPlan;
  const runtimeId = runtime.agentHarness.id;
  if (
    program !== undefined ||
    !consumesCyberAccessPrograms({ provider, runtimeId, route: auth.modelRoute }) ||
    preparedModelRuntime?.isCurrent() !== true
  ) {
    return undefined;
  }
  const read = await prepareAttemptAccessPrograms({
    preparedModelRuntime,
    authProfileId: runtime.lastProfileId,
    authProfileStore: input.preparedRuntime.resolveRunAttemptAuthProfileStore(),
    provider,
    modelId,
    auth,
    runtimeId,
  });
  return read();
}

/** Effective Access, including configured defaults, requires current role and account authority. */
export async function prepareEmbeddedAccessProgramGuard(
  attempt: Pick<
    EmbeddedRunAttemptParams,
    | "cyberAccessProgram"
    | "preparedModelRuntime"
    | "authProfileId"
    | "authProfileStore"
    | "provider"
    | "modelId"
    | "runtimePlan"
    | "admittedRunContext"
  >,
  extraParams?: Record<string, unknown>,
): Promise<(() => void) | undefined> {
  const program =
    attempt.cyberAccessProgram ?? asOptionalRecord(extraParams?.accessPrograms)?.cyber;
  if (
    program !== undefined &&
    program !== "standard" &&
    program !== "daybreak_blue" &&
    program !== "daybreak_red"
  ) {
    throw new Error("Invalid OpenAI cyber access program.");
  }
  const assertRole = () =>
    assertOperatorAccessProgramAllowed(readRunOperatorAuthority(attempt), program);
  assertRole();
  if (program === undefined || program === "standard") {
    return assertRole;
  }
  const readPrograms = await prepareAttemptAccessPrograms({
    ...attempt,
    auth: attempt.runtimePlan?.auth,
    runtimeId: "openclaw",
  });
  const check = () => {
    assertRole();
    const programs = readPrograms();
    if (!programs?.includes(program)) {
      const supported = programs?.map((value) => accessProgramLabels[value]);
      const daybreak = programs?.find((value) => value !== "standard");
      const guidance = !daybreak
        ? "Turn Daybreak off for this chat."
        : `Turn on Daybreak for this chat to use ${accessProgramLabels[daybreak]}.`;
      throw new FailoverError(
        supported?.length
          ? `${attempt.modelId} supports ${supported.join(" and ")}${supported.length === 1 ? " only" : ""}. This chat requested ${accessProgramLabels[program]}. ${guidance}`
          : "This Daybreak program is not advertised for the current account, model, and runtime. Turn Daybreak off for this chat or refresh account capabilities.",
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
