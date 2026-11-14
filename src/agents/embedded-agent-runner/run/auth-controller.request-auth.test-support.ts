import { vi } from "vitest";
import type { ProviderExternalAuthProfile } from "../../../plugins/provider-external-auth.types.js";
import { writeConfigMachineState } from "../../../state/config-machine-state-write.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { oauthCred } from "../../auth-profiles/credential-fixtures.test-support.js";
import { createExternalAuthRuntime } from "../../auth-profiles/external-auth.js";
import { mockOAuthProviderOperations } from "../../auth-profiles/oauth-native-provider.test-support.js";
import { storeWith } from "../../auth-profiles/oauth-test-utils.js";
import { createAuthProfileStoreRuntime } from "../../auth-profiles/store.js";
import type { AuthProfileStore } from "../../auth-profiles/types.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import { createEmbeddedRunAuthController, type EmbeddedRunAuthState } from "./auth-controller.js";
import { createScopedAuthProfileStore } from "./auth-store.js";

export const provider = "request-auth-fixture";
export const profileId = `${provider}:selected`;

type RequestFixture = {
  state: Parameters<Parameters<typeof withOpenClawTestState>[1]>[0];
  credential: ReturnType<typeof oauthCred>;
  agentDir: string;
  controller: ReturnType<typeof createEmbeddedRunAuthController>;
  authState: EmbeddedRunAuthState;
  authStore: AuthProfileStore;
  refresh: ReturnType<
    typeof vi.fn<
      (credential: ReturnType<typeof oauthCred>) => Promise<ReturnType<typeof oauthCred>>
    >
  >;
  installed(this: void): string;
};
export async function withRequestFixture(
  run: (fixture: RequestFixture) => Promise<void>,
  {
    agentId = "main",
    sharedStateOwner = false,
    replacement = false,
    externalProfile,
  }: {
    agentId?: string;
    sharedStateOwner?: boolean;
    replacement?: boolean;
    externalProfile?: Pick<ProviderExternalAuthProfile, "profileId" | "persistence">;
  } = {},
) {
  await withOpenClawTestState(
    { layout: "state-only", agentEnv: "main", prefix: "request-auth-" },
    async (state) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(1_900_000_000_000);
      const credential = oauthCred({
        provider,
        access: "synthetic-access-before",
        refresh: "synthetic-refresh-before",
        expires: Date.now() + 3_600_000,
        accountId: "account-a",
      });
      const store = storeWith(profileId, {
        ...credential,
        ...(replacement
          ? { setup: { replacement: true, modelRef: `${provider}/chat`, configJson: "{}" } }
          : {}),
      });
      if (sharedStateOwner) {
        writeConfigMachineState("auth.sharedStore", { location: "state-db" });
      }
      await state.writeAuthProfiles(
        externalProfile?.profileId === profileId && externalProfile.persistence !== "persisted"
          ? { version: 1, profiles: {} }
          : store,
        agentId,
      );
      const agentDir = state.agentDir(agentId);
      const authStore = externalProfile
        ? createScopedAuthProfileStore(
            await createAuthProfileStoreRuntime(
              createExternalAuthRuntime(
                () => [{ ...externalProfile, credential }],
                async (_params, execute) => execute(),
              ),
            ).ensureAuthProfileStoreAsync(agentDir, {
              readOnly: true,
              syncExternalCli: false,
              config: { plugins: { enabled: false } },
            }),
            [profileId, externalProfile.profileId],
          )
        : store;
      const refresh = vi.fn(async () => ({
        ...credential,
        access: "synthetic-access-after",
        refresh: "synthetic-refresh-after",
        expires: Date.now() + 3_600_000,
      }));
      mockOAuthProviderOperations({ refreshCredential: refresh });
      const model = makeProviderModelFixture({
        provider,
        api: "request-auth-fixture",
        id: "chat",
        baseUrl: "https://example.test",
      });
      const authState: EmbeddedRunAuthState = {
        models: { runtime: model, effective: model },
        apiKeyInfo: null,
        lastProfileId: undefined,
        runtimeAuthState: null,
        runtimeAuthRefreshCancelled: false,
        profileIndex: 0,
        thinkLevel: "off",
      };
      let installed = "";
      const controller = createEmbeddedRunAuthController({
        config: { plugins: { enabled: false } },
        agentDir,
        workspaceDir: state.workspaceDir,
        authStore,
        authStorage: {
          setRuntimeApiKey: (_provider, key) => {
            installed = key;
          },
        },
        profileCandidates: [profileId],
        initialThinkLevel: "off",
        attemptedThinking: new Set(),
        fallbackConfigured: false,
        allowTransientCooldownProbe: false,
        provider,
        modelId: model.id,
        state: authState,
        log: { debug() {}, info() {}, warn() {} },
      });

      try {
        await run({
          state,
          credential,
          agentDir,
          controller,
          authState,
          authStore,
          refresh,
          installed: () => installed,
        });
      } finally {
        controller.stopRuntimeAuthRefreshTimer();
      }
    },
  );
}
