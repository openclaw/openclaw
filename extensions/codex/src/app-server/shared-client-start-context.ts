import { resolveDefaultAgentDir } from "openclaw/plugin-sdk/agent-harness-registration";
import {
  bridgeCodexAppServerStartOptions,
  resolveCodexAppServerPreparedAuthProfileSnapshot,
} from "./auth-bridge.js";
import {
  CodexAppServerAuthProfileUnavailableError,
  formatCodexAuthProfileUnavailableMessage,
} from "./auth-profile-recovery.js";
import {
  resolveCodexAppServerAuthProfileIdForAgent,
  resolveCodexAppServerAuthProfileStore,
} from "./auth-profile.js";
import type * as codexAuth from "./auth-types.js";
import { resolveRemainingAcquireTimeout } from "./client-startup-retry.js";
import {
  resolveCodexAppServerRuntimeOptions,
  resolveCodexAppServerStartOptionsForAgent,
} from "./config-runtime.js";
import { waitForCodexDesktopGeneration } from "./desktop-generation.js";
import { resolveManagedCodexAppServerStartOptions } from "./managed-binary.js";
import { isCodexResponsesOAuth } from "./responses-oauth.js";
import type { CodexAppServerClientOptions } from "./shared-client-options.js";
import { shouldTrackDesktopGeneration } from "./shared-client-start-policy.js";

export async function resolveCodexAppServerClientStartContext(
  options: CodexAppServerClientOptions | undefined,
  startedAt: number,
) {
  const requestedStartOptions =
    options?.startOptions ??
    resolveCodexAppServerRuntimeOptions({ pluginConfig: options?.pluginConfig }).start;
  const agentDir =
    options?.agentDir ??
    (requestedStartOptions.homeScope === "user"
      ? undefined
      : resolveDefaultAgentDir(options?.config ?? {}));
  const desktopGeneration = shouldTrackDesktopGeneration(
    requestedStartOptions,
    options?.pluginConfig,
  )
    ? await waitForCodexDesktopGeneration()
    : undefined;
  const preparedAuth = options?.preparedAuth;
  const preparedApiKey = preparedAuth?.kind === "api-key" ? preparedAuth.apiKey.trim() : undefined;
  if (preparedAuth && options?.authProfileId !== undefined) {
    throw new Error("Prepared Codex auth cannot also select a legacy auth profile.");
  }
  if (preparedAuth?.kind === "profile" && !preparedAuth.store.profiles[preparedAuth.profileId]) {
    throw new CodexAppServerAuthProfileUnavailableError(
      formatCodexAuthProfileUnavailableMessage(preparedAuth.profileId),
    );
  }
  if (preparedAuth?.kind === "api-key" && !preparedApiKey) {
    throw new Error("Prepared Codex API-key auth is missing its resolved key.");
  }
  if (preparedAuth && requestedStartOptions.homeScope === "user") {
    // Backstop for the auth-bridge handoff: an app-server on the operator's native
    // home persists api-key logins into CODEX_HOME/auth.json and replaces the live
    // ChatGPT account for token logins, so prepared auth must never reach it.
    throw new Error("Prepared Codex auth requires an isolated app-server home.");
  }
  const preparedAuthRequirement =
    preparedAuth &&
    (preparedAuth.kind === "api-key" || isCodexResponsesOAuth(preparedAuth)
      ? "api-key"
      : "subscription");
  if (
    options?.authRequirement &&
    preparedAuthRequirement &&
    options.authRequirement !== preparedAuthRequirement
  ) {
    throw new Error("Prepared Codex auth does not satisfy the requested auth requirement.");
  }
  let authRequirement = options?.authRequirement ?? preparedAuthRequirement;
  const usesNativeAuth =
    !preparedAuth &&
    (options?.authProfileId === null || requestedStartOptions.homeScope === "user");
  const requestedAuthProfileId =
    preparedAuth?.kind === "profile"
      ? preparedAuth.profileId
      : (options?.authProfileId ?? undefined);
  const authProfileStore =
    preparedAuth?.kind === "profile"
      ? preparedAuth.store
      : !usesNativeAuth && preparedAuth?.kind !== "api-key"
        ? await resolveCodexAppServerAuthProfileStore({
            agentDir,
            authProfileId: requestedAuthProfileId,
            authProfileStore: options?.authProfileStore,
            config: options?.config,
          })
        : options?.authProfileStore;
  const authProfileId =
    preparedAuth?.kind === "profile"
      ? preparedAuth.profileId
      : usesNativeAuth || preparedAuth?.kind === "api-key"
        ? undefined
        : await resolveCodexAppServerAuthProfileIdForAgent({
            authProfileId: requestedAuthProfileId,
            agentDir,
            config: options?.config,
            ...(authProfileStore ? { authProfileStore } : {}),
          });
  // Resolve the selected profile once: the keyed process must log in with the
  // same account material, including ordinary catalog callers without prepared auth.
  const preparedAuthProfileSnapshot =
    !usesNativeAuth && authProfileId
      ? ((preparedAuth?.kind === "profile" ? preparedAuth.snapshot : undefined) ??
        (await resolveCodexAppServerPreparedAuthProfileSnapshot({
          authProfileId,
          authProfileStore,
          agentDir,
          config: options?.config,
        })))
      : undefined;
  if (preparedAuth?.kind === "profile" && !preparedAuthProfileSnapshot) {
    throw new CodexAppServerAuthProfileUnavailableError(
      `Prepared Codex auth profile "${preparedAuth.profileId}" is unusable. Repair or replace the selected OpenAI profile, then retry.`,
    );
  }
  const resolvedPreparedAuth: codexAuth.CodexAppServerResolvedPreparedAuth | undefined =
    preparedAuth?.kind === "api-key" && preparedApiKey
      ? { kind: "api-key", apiKey: preparedApiKey }
      : preparedAuthProfileSnapshot && authProfileId && authProfileStore
        ? {
            kind: "profile",
            profileId: authProfileId,
            store: authProfileStore,
            snapshot: preparedAuthProfileSnapshot,
          }
        : undefined;
  if (isCodexResponsesOAuth(resolvedPreparedAuth)) {
    if (authRequirement && authRequirement !== "api-key") {
      throw new Error("ChatGPT subscription sharing requires the public OpenAI API route.");
    }
    authRequirement = "api-key";
  }
  const agentStartOptions = resolveCodexAppServerStartOptionsForAgent({
    startOptions: requestedStartOptions,
    agentDir,
  });
  const remainingMs = resolveRemainingAcquireTimeout(options?.timeoutMs ?? 0, startedAt);
  const managedStartOptions = await resolveManagedCodexAppServerStartOptions(agentStartOptions, {
    selectionTimeoutMs: remainingMs > 0 ? remainingMs / 2 : undefined,
  });
  // Preserve ordinary profile environment policy; only explicitly prepared
  // handoffs clear all inherited auth variables before spawning.
  const startOptions = await bridgeCodexAppServerStartOptions({
    startOptions: managedStartOptions,
    agentId: options?.agentId,
    agentDir,
    authProfileId: usesNativeAuth || preparedAuth?.kind === "api-key" ? null : authProfileId,
    ...((preparedAuth || isCodexResponsesOAuth(resolvedPreparedAuth)) && resolvedPreparedAuth
      ? { preparedAuth: resolvedPreparedAuth }
      : {}),
    authRequirement,
    config: options?.config,
    pluginConfig: options?.pluginConfig,
    ...(authProfileStore ? { authProfileStore } : {}),
  });
  return {
    agentDir,
    usesNativeAuth,
    authProfileId,
    authProfileStore,
    requestedStartOptions,
    preparedAuth: resolvedPreparedAuth,
    authRequirement,
    startOptions,
    ...(options?.pluginConfig !== undefined ? { pluginConfig: options.pluginConfig } : {}),
    ...(desktopGeneration ? { desktopGeneration } : {}),
  };
}
