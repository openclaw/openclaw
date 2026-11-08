import { resolveDefaultAgentDir } from "openclaw/plugin-sdk/agent-harness-registration";
import { prepareCodexAppServerAuthBinding } from "./auth-binding.js";
import {
  resolveCodexAppServerAuthProfileIdForAgent,
  resolveCodexAppServerAuthProfileStore,
} from "./auth-profile.js";
import {
  codexAppServerStartOptionsKey,
  resolveCodexAppServerRuntimeOptions,
} from "./config-runtime.js";
import { readRecentCodexRateLimits } from "./rate-limit-cache.js";
import { createSharedCodexAppServerClientKeyResolver } from "./shared-client-key.js";
import { getSharedCodexAppServerClientState } from "./shared-client-lifecycle.js";
import {
  captureSharedClientRegistration,
  prepareCodexAppServerClient,
  type CodexAppServerClientOptions,
} from "./shared-client.js";

/** Reads an already-owned subscription snapshot without acquiring or starting a client. */
export async function readSharedCodexAppServerUsage(
  options: CodexAppServerClientOptions,
  maxAgeMs: number,
) {
  const state = getSharedCodexAppServerClientState();
  if (maxAgeMs <= 0 || state.clients.size === 0 || options.preparedAuth?.kind === "api-key") {
    return undefined;
  }
  const startOptions =
    options.startOptions ??
    resolveCodexAppServerRuntimeOptions({ pluginConfig: options.pluginConfig }).start;
  // Native-home accounts can change outside OpenClaw's credential ownership.
  if (startOptions.homeScope === "user" || options.authProfileId === null) {
    return undefined;
  }
  const agentDir = options.agentDir ?? resolveDefaultAgentDir(options.config ?? {});
  const startKey = codexAppServerStartOptionsKey(startOptions);
  if (
    ![...state.clients.values()].some(({ client, ready, closeWhenIdle }) => {
      const metadata = client && state.startMetadata.get(client);
      return (
        ready &&
        !closeWhenIdle &&
        metadata?.agentDir === agentDir &&
        codexAppServerStartOptionsKey(metadata.requestedStartOptions) === startKey
      );
    })
  ) {
    return undefined;
  }
  const prepared = options.preparedAuth;
  const store =
    prepared?.store ??
    (await resolveCodexAppServerAuthProfileStore({
      ...options,
      authProfileId: options.authProfileId ?? undefined,
      agentDir,
    }));
  const profileId =
    prepared?.profileId ??
    (await resolveCodexAppServerAuthProfileIdForAgent({
      ...options,
      authProfileId: options.authProfileId ?? undefined,
      agentDir,
      authProfileStore: store,
    }));
  if (!profileId || !store) {
    return undefined;
  }
  const binding = await prepareCodexAppServerAuthBinding({
    authProfileId: profileId,
    authProfileStore: store,
    agentDir,
    config: options.config ?? {},
  });
  if (!binding) {
    return undefined;
  }
  const { context, assertCurrent } = await prepareCodexAppServerClient({
    ...options,
    agentDir,
    authProfileId: undefined,
    preparedAuth: { kind: "profile", profileId, store: binding.authProfileStore },
    authBindingFingerprint: binding.fingerprint,
  });
  assertCurrent();
  options.assertCurrent?.();
  const keyFor = createSharedCodexAppServerClientKeyResolver({
    ...context,
    authBindingFingerprint: binding.fingerprint,
  });
  const entry = state.clients.get(keyFor(context.startOptions));
  const client = entry?.client;
  if (!entry?.ready || !client || !captureSharedClientRegistration(client)()) {
    return undefined;
  }
  const rateLimits = readRecentCodexRateLimits(client, maxAgeMs);
  const accountEmail = store.profiles[profileId]?.email;
  return rateLimits === undefined
    ? undefined
    : { rateLimits, ...(accountEmail ? { accountEmail } : {}) };
}
