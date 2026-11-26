import { describe, expect, it, vi } from "vitest";
import { mintSecretSentinel } from "../secrets/sentinel.js";
import { createApiKeyCredential } from "./auth-profiles/credential-fixtures.test-support.js";
import * as btw from "./btw.test-support.js";

vi.mock("./auth-profiles/store-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth-profiles/store-runtime.js")>()),
  loadAuthProfileStoreForRuntimeAsync: (...args: unknown[]) =>
    btw.ensureAuthProfileStoreMock(...args),
}));

describe("BTW account policy", () => {
  btw.setupBtwTestHooks();

  it.each([false, true])("preserves direct BTW account policy (required=%s)", async (required) => {
    const authStorage = { id: "btw-auth-storage" };
    const modelRegistry = { id: "btw-model-registry" };
    const authStore = {
      version: 1 as const,
      profiles: {
        "anthropic:primary": createApiKeyCredential("anthropic", "primary-key"),
        "anthropic:backup": {
          type: "api_key" as const,
          provider: "anthropic",
          keyRef: {
            source: "file" as const,
            provider: "vault",
            id: "/anthropic/backup",
          },
        },
      },
      order: { anthropic: ["anthropic:primary", "anthropic:backup"] },
    };
    const rotatedModel = {
      provider: "anthropic",
      id: btw.DEFAULT_MODEL,
      api: "anthropic-messages" as const,
      baseUrl: "https://backup.example.test",
      name: "Backup profile model",
    };
    btw.discoverAuthStorageMock.mockReturnValue(authStorage);
    btw.discoverModelsMock.mockReturnValue(modelRegistry);
    btw.resolveModelWithRegistryMock.mockReturnValue({
      provider: "anthropic",
      id: btw.DEFAULT_MODEL,
      api: "anthropic-messages",
      baseUrl: "https://primary.example.test",
      name: "Primary profile model",
    });
    btw.resolveModelAsyncMock.mockResolvedValue({
      model: rotatedModel,
      authStorage,
      modelRegistry,
    });
    btw.ensureAuthProfileStoreWithoutExternalProfilesMock.mockReturnValue(authStore);
    btw.resolveSessionAuthSelectionMock.mockResolvedValue(undefined);
    btw.getApiKeyForModelMock.mockImplementation(
      async (authParams: { profileId?: string } = {}) => {
        if (authParams.profileId === "anthropic:primary") {
          throw new Error("primary credential resolution failed");
        }
        if (authParams.profileId === "anthropic:backup") {
          return {
            apiKey: mintSecretSentinel("backup-secret", { label: "btw-backup" }),
            mode: "api-key",
            source: "profile:anthropic:backup",
            profileId: "anthropic:backup",
          };
        }
        throw new Error(`unexpected profile: ${authParams.profileId ?? "none"}`);
      },
    );
    btw.requireApiKeyMock.mockReturnValue("backup-secret");
    btw.mockDoneAnswer("Backup answer.");

    const result = btw.runSideQuestion({
      ...(required
        ? {
            sessionEntry: btw.createSessionEntry({
              authProfileOverride: "anthropic:primary",
              authProfileOverrideRequired: true,
            }),
          }
        : {}),
      cfg: {
        secrets: {
          providers: {
            vault: { source: "file", path: "/tmp/btw-secrets.json", mode: "json" },
          },
        },
      } as never,
    });
    if (required) {
      await expect(result).rejects.toThrow("primary credential resolution failed");
      expect(btw.streamSimpleMock).not.toHaveBeenCalled();
      expect(btw.getApiKeyForModelMock.mock.calls.map(([p]) => p.profileId)).toEqual([
        "anthropic:primary",
      ]);
      return;
    }
    await expect(result).resolves.toEqual({ text: "Backup answer." });

    expect(
      btw.getApiKeyForModelMock.mock.calls.map(
        ([authParams]) => (authParams as { profileId?: string }).profileId,
      ),
    ).toEqual(["anthropic:primary", "anthropic:backup"]);
    expect(btw.resolveModelAsyncMock).toHaveBeenCalledWith(
      "anthropic",
      btw.DEFAULT_MODEL,
      btw.DEFAULT_AGENT_DIR,
      expect.any(Object),
      expect.objectContaining({
        authStorage,
        modelRegistry,
        authProfileId: "anthropic:backup",
        authProfileMode: "api_key",
        preparedModelRuntime: expect.objectContaining({
          configuredRuntimeModels: [],
          inlineProviderModels: [],
        }),
        skipAgentDiscovery: true,
      }),
    );
    const preparedAuthContext = btw.expectRecordFields(
      (btw.mockArg(btw.prepareProviderRuntimeAuthMock, 0, 0) as { context?: unknown }).context,
      {
        provider: "anthropic",
        modelId: btw.DEFAULT_MODEL,
        model: rotatedModel,
        profileId: "anthropic:backup",
      },
    );
    expect(preparedAuthContext.apiKey).toBe("backup-secret");
    btw.expectRecordFields(btw.mockArg(btw.streamSimpleMock, 0, 0), {
      name: "Backup profile model",
      baseUrl: "https://backup.example.test",
    });
  });
  it.each(["anthropic", "openai"])(
    "validates required BTW account compatibility before CLI preparation (%s)",
    async (provider) => {
      const profileId = `${provider}:delegated`;
      btw.ensureAuthProfileStoreMock.mockReturnValue({
        version: 1,
        profiles: { [profileId]: createApiKeyCredential(provider, "synthetic-key") },
      });
      btw.mockCliOutput({ text: "CLI answer." });
      const result = btw.runSideQuestion({
        cfg: btw.createCliRuntimeConfig(),
        model: "claude-opus-4-7",
        sessionEntry: btw.createSessionEntry({
          authProfileOverride: profileId,
          authProfileOverrideRequired: true,
        }),
      });
      if (provider === "anthropic") {
        await expect(result).resolves.toEqual({ text: "CLI answer." });
        expect(btw.prepareCliRunContextMock).toHaveBeenCalledOnce();
      } else {
        await expect(result).rejects.toThrow(/cannot use auth profile/);
        expect(btw.prepareCliRunContextMock).not.toHaveBeenCalled();
        expect(btw.executePreparedCliRunMock).not.toHaveBeenCalled();
      }
    },
  );
});
