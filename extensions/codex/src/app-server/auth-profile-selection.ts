// Bind one auth selection policy to either the host runtime or the cold SDK entrypoint.
import { resolveDefaultAgentDir } from "openclaw/plugin-sdk/agent-harness-registration";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { AuthProfileStore } from "openclaw/plugin-sdk/provider-auth";

const loadProviderAuthRuntime = createLazyRuntimeModule(
  () => import("openclaw/plugin-sdk/provider-auth-runtime"),
);

type ProfileAuth = Pick<
  PluginRuntime["modelAuth"],
  "ensureAuthProfileStoreAsync" | "resolveAuthProfileOrder"
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
  ensureAuthProfileStoreAsync,
  resolveAuthProfileOrder,
}: ProfileAuth) {
  function resolveCodexAppServerAuthProfileId(params: {
    authProfileId?: string;
    store: AuthProfileStore;
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

  async function resolveCodexAppServerAuthProfileIdForAgent(
    params: CodexAppServerAuthProfileLookup,
  ): Promise<string | undefined> {
    const requested = params.authProfileId?.trim();
    if (requested) {
      return requested;
    }
    const agentDir = params.agentDir?.trim() || resolveDefaultAgentDir(params.config ?? {});
    const store = await resolveCodexAppServerAuthProfileStore({ ...params, agentDir });
    return resolveCodexAppServerAuthProfileId({ ...params, store });
  }

  /** Retain current selection authority through the guarded external effect. */
  async function withCodexAppServerAuthProfileIdAtEffect<T>(
    params: CodexAppServerAuthProfileLookup,
    consume: (reader: { read(): Promise<string | undefined>; assertCurrent(): void }) => Promise<T>,
  ): Promise<T> {
    const requested = params.authProfileId?.trim();
    if (requested) {
      return consume({ read: async () => requested, assertCurrent() {} });
    }
    const agentDir = params.agentDir?.trim() || resolveDefaultAgentDir(params.config ?? {});
    const { withAuthProfileStoreAtEffect } = await loadProviderAuthRuntime();
    return withAuthProfileStoreAtEffect(agentDir, storeOptions(params), (reader) =>
      consume({
        read: async () =>
          resolveCodexAppServerAuthProfileId({ ...params, store: await reader.read() }),
        assertCurrent: () => reader.assertCurrent(),
      }),
    );
  }

  function storeOptions(params: CodexAppServerAuthProfileLookup) {
    return {
      profileId: params.authProfileId,
      allowKeychainPrompt: false,
      config: params.config,
      externalCliProviderIds: CODEX_APP_SERVER_EXTERNAL_CLI_PROVIDER_IDS,
      ...(params.authProfileId ? { externalCliProfileIds: [params.authProfileId] } : {}),
    };
  }

  async function resolveCodexAppServerAuthProfileStore(
    params: CodexAppServerAuthProfileLookup,
  ): Promise<AuthProfileStore> {
    if (params.authProfileStore) {
      return params.authProfileStore;
    }
    return ensureAuthProfileStoreAsync(params.agentDir, storeOptions(params));
  }
  return {
    resolveCodexAppServerAuthProfileId,
    resolveCodexAppServerAuthProfileIdForAgent,
    withCodexAppServerAuthProfileIdAtEffect,
    resolveCodexAppServerAuthProfileStore,
  };
}
