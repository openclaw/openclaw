import { isDeepStrictEqual } from "node:util";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  isUserModelAuthProfileId,
  resolveApiKeyForProvider,
  withAuthProfileStoreAtEffect,
  withPersonalAuthProfileStore,
} from "openclaw/plugin-sdk/provider-auth-runtime";

export type GoogleResearchAuthContext = {
  api: OpenClawPluginApi;
  agentId: string;
  signal: AbortSignal;
  assertCurrent: () => void;
};

type Auth = Awaited<ReturnType<typeof resolveApiKeyForProvider>>;
type Store = NonNullable<Parameters<typeof resolveApiKeyForProvider>[0]["store"]>;

/** Retain the selected credential owner through DNS preparation and the paid effect. */
export async function withGoogleResearchAuth<T>(
  profileId: string,
  context: GoogleResearchAuthContext,
  consume: (auth: Auth, assertCredentialCurrent: () => void) => Promise<T>,
): Promise<T> {
  const agentDir = context.api.runtime.agent.resolveAgentDir(context.api.config, context.agentId);
  const run = async (store: Store, assertCredentialCurrent: () => void) => {
    assertCredentialCurrent();
    context.assertCurrent();
    const auth = await resolveApiKeyForProvider({
      provider: "google",
      profileId,
      lockedProfile: true,
      cfg: context.api.config,
      agentDir,
      signal: context.signal,
      store,
    });
    assertCredentialCurrent();
    return consume(auth, assertCredentialCurrent);
  };
  if (isUserModelAuthProfileId(profileId)) {
    const result = await withPersonalAuthProfileStore(profileId, async (owner) => {
      const store = await owner.read();
      const credential = structuredClone(store.profiles[profileId]);
      const readCurrentCredential = owner.readCurrentCredential;
      return {
        value: await run(store, () => {
          if (!isDeepStrictEqual(readCurrentCredential(), credential)) {
            throw new Error("Selected research credential changed");
          }
        }),
      };
    });
    if (!result) {
      throw new Error("Selected research credential unavailable");
    }
    return result.value;
  }
  return withAuthProfileStoreAtEffect(
    agentDir,
    { profileId, allowKeychainPrompt: false, config: context.api.config },
    async (reader) => run(await reader.read(), reader.assertCurrent),
  );
}
