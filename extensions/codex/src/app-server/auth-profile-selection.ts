// Bind one auth selection policy to either the host runtime or the cold SDK entrypoint.
import { resolveDefaultAgentDir } from "openclaw/plugin-sdk/agent-harness-registration";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { AuthProfileStore } from "openclaw/plugin-sdk/provider-auth";

type ProfileAuth = Pick<
  PluginRuntime["modelAuth"],
  "ensureAuthProfileStore" | "resolveAuthProfileOrder"
>;
type AuthProfileOrderConfig = Parameters<ProfileAuth["resolveAuthProfileOrder"]>[0]["cfg"];
export const CODEX_APP_SERVER_AUTH_PROVIDER = "openai";
const CODEX_APP_SERVER_EXTERNAL_CLI_PROVIDER_IDS = [CODEX_APP_SERVER_AUTH_PROVIDER];

export type CodexAppServerAuthProfileLookup = {
  authProfileId?: string;
  authProfileStore?: AuthProfileStore;
  agentDir?: string;
  config?: AuthProfileOrderConfig;
};

export function createCodexAuthProfileSelection({
  ensureAuthProfileStore,
  resolveAuthProfileOrder,
}: ProfileAuth) {
  function resolveCodexAppServerAuthProfileId(params: {
    authProfileId?: string;
    store: ReturnType<typeof ensureAuthProfileStore>;
    config?: AuthProfileOrderConfig;
  }): string | undefined {
    const requested = params.authProfileId?.trim();
    if (requested) {
      return requested;
    }
    return resolveAuthProfileOrder({
      cfg: params.config,
      store: params.store,
      provider: CODEX_APP_SERVER_AUTH_PROVIDER,
    })[0]?.trim();
  }

  function resolveCodexAppServerAuthProfileIdForAgent(
    params: CodexAppServerAuthProfileLookup,
  ): string | undefined {
    const agentDir = params.agentDir?.trim() || resolveDefaultAgentDir(params.config ?? {});
    const store = resolveCodexAppServerAuthProfileStore({ ...params, agentDir });
    return resolveCodexAppServerAuthProfileId({ ...params, store });
  }

  function resolveCodexAppServerAuthProfileStore(
    params: CodexAppServerAuthProfileLookup,
  ): AuthProfileStore {
    if (params.authProfileStore) {
      return params.authProfileStore;
    }
    return ensureAuthProfileStore(params.agentDir, {
      profileId: params.authProfileId,
      allowKeychainPrompt: false,
      config: params.config,
      externalCliProviderIds: CODEX_APP_SERVER_EXTERNAL_CLI_PROVIDER_IDS,
      ...(params.authProfileId ? { externalCliProfileIds: [params.authProfileId] } : {}),
    });
  }
  return {
    resolveCodexAppServerAuthProfileId,
    resolveCodexAppServerAuthProfileIdForAgent,
    resolveCodexAppServerAuthProfileStore,
  };
}
