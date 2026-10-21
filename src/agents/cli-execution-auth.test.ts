import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiKeyCredential } from "./auth-profiles/credential-fixtures.test-support.js";
import type { AuthProfileCredential } from "./auth-profiles/types.js";
import { testing as cliBackendsTesting } from "./cli-backends.test-support.js";

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  profiles: {} as Record<string, AuthProfileCredential>,
}));

// mock-isolation: profile selection uses fixture credentials without opening runtime auth stores.
vi.mock("./auth-profiles/store-runtime.js", () => ({
  loadAuthProfileStoreForRuntimeAsync: async () => ({ version: 1, profiles: mocks.profiles }),
}));

vi.mock("./auth-profiles/order.js", () => ({
  resolveAuthProfileOrderWithMetadata: () => ({
    profileIds: mocks.order,
    hasExplicitOrder: false,
  }),
}));

import { resolveCliExecutionAuthProfileId } from "./cli-execution-auth.js";

type AuthParams = Parameters<typeof resolveCliExecutionAuthProfileId>[0];
function resolveAuth(
  cliExecutionProvider: string,
  authProfileProvider: string,
  authProfileId: string,
  overrides: Partial<AuthParams> = {},
) {
  return resolveCliExecutionAuthProfileId({
    cliExecutionProvider,
    authProfileProvider,
    config: {},
    agentDir: "/tmp/unused-agent",
    selected: { authProfileId, authProfileIdSource: "user" },
    ...overrides,
  });
}

function oauth(provider: string, expires = Date.now() + 60_000): AuthProfileCredential {
  return { type: "oauth", provider, access: "test-access", refresh: "test-refresh", expires };
}

describe("resolveCliExecutionAuthProfileId", () => {
  beforeEach(() => {
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [
        {
          id: "claude-cli",
          modelProvider: "anthropic",
          pluginId: "anthropic",
          config: { command: "claude" },
        },
        {
          id: "google-gemini-cli",
          modelProvider: "google",
          pluginId: "google-gemini-cli",
          config: { command: "gemini" },
        },
      ],
      resolvePluginSetupCliBackend: () => undefined,
    });
    mocks.order.length = 0;
    for (const profileId of Object.keys(mocks.profiles)) {
      delete mocks.profiles[profileId];
    }
  });

  afterEach(() => {
    cliBackendsTesting.resetDepsForTest();
  });

  it.each(["auto", "user"] as const)(
    "ignores a retired native Claude profile selected by %s",
    async (authProfileIdSource) => {
      const authProfileId = "anthropic:claude-cli";
      mocks.profiles[authProfileId] = oauth("claude-cli", Date.now() - 60_000);
      mocks.order.push(authProfileId);

      await expect(
        resolveAuth("claude-cli", "claude-cli", authProfileId, {
          selected: { authProfileId, authProfileIdSource },
        }),
      ).resolves.toBeUndefined();
    },
  );

  it("keeps forwarding a non-retired Claude profile", async () => {
    const authProfileId = "claude-cli:work";
    mocks.profiles[authProfileId] = oauth("claude-cli");

    await expect(resolveAuth("claude-cli", "claude-cli", authProfileId)).resolves.toBe(
      authProfileId,
    );
  });

  it.each([
    { type: "api_key", registry: "runtime" },
    { type: "token", registry: "runtime" },
    { type: "oauth", registry: "runtime" },
    { type: "token", registry: "setup" },
  ] as const)(
    "forwards an explicitly selected canonical Anthropic $type through the $registry registry",
    async ({ type, registry }) => {
      if (registry === "setup") {
        cliBackendsTesting.setDepsForTest({
          resolveRuntimeCliBackends: () => [],
          resolvePluginSetupCliBackend: ({ backend }) =>
            backend === "claude-cli"
              ? {
                  pluginId: "anthropic",
                  backend: {
                    id: "claude-cli",
                    modelProvider: "anthropic",
                    config: { command: "claude" },
                  },
                }
              : undefined,
        });
      }
      const authProfileId = `anthropic:managed-${type}`;
      mocks.profiles[authProfileId] =
        type === "api_key"
          ? { type, provider: "anthropic", key: "test-anthropic-key" }
          : type === "oauth"
            ? oauth("anthropic")
            : { type, provider: "anthropic", token: "test-anthropic-token" };

      await expect(resolveAuth("claude-cli", "anthropic", authProfileId)).resolves.toBe(
        authProfileId,
      );
    },
  );

  it("loads the selected personal profile without falling back to an ambient Claude account", async () => {
    const authProfileId =
      "personal:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222";
    const credential: AuthProfileCredential = {
      type: "token",
      provider: "anthropic",
      token: "test-personal-anthropic-token",
    };
    mocks.profiles["claude-cli:ambient"] = createApiKeyCredential("claude-cli", "test-ambient-key");
    mocks.order.push("claude-cli:ambient");

    await expect(
      resolveAuth("claude-cli", "anthropic", authProfileId, {
        loadAuthProfileStoreForRuntimeAsync: async (_agentDir, options) => ({
          version: 1,
          profiles: {
            ...mocks.profiles,
            ...(options?.profileId === authProfileId ? { [authProfileId]: credential } : {}),
          },
        }),
      }),
    ).resolves.toBe(authProfileId);
  });

  it.each(["absent", "auto"] as const)(
    "forwards only automatic Claude profiles owned by Claude CLI (%s selection)",
    async (selection) => {
      const selected =
        selection === "auto"
          ? { authProfileId: "anthropic:default", authProfileIdSource: "auto" as const }
          : undefined;
      mocks.profiles["anthropic:default"] = createApiKeyCredential(
        "anthropic",
        "test-anthropic-key",
      );
      mocks.order.push("anthropic:default");

      await expect(
        resolveAuth("claude-cli", "anthropic", "anthropic:default", { selected }),
      ).resolves.toBeUndefined();

      mocks.profiles["claude-cli:work"] = createApiKeyCredential("claude-cli", "test-claude-key");
      mocks.order.push("claude-cli:work");

      await expect(
        resolveAuth("claude-cli", "anthropic", "anthropic:default", { selected }),
      ).resolves.toBe("claude-cli:work");
    },
  );

  it.each(["claude-cli", "google-gemini-cli"])(
    "rejects an explicitly selected profile from another provider for %s",
    async (cliExecutionProvider) => {
      mocks.profiles["openai:work"] = createApiKeyCredential("openai", "test-openai-key");

      await expect(resolveAuth(cliExecutionProvider, "openai", "openai:work")).rejects.toThrow(
        /cannot use auth profile "openai:work"/,
      );
    },
  );

  it("rejects a missing explicitly selected profile instead of changing identities", async () => {
    await expect(
      resolveAuth("google-gemini-cli", "google-gemini-cli", "google-gemini-cli:missing"),
    ).rejects.toThrow(/No credentials found for profile "google-gemini-cli:missing"/);
  });

  it("bridges only a stored canonical Google API key to Gemini CLI", async () => {
    mocks.profiles["google:work"] = createApiKeyCredential("google", "test-google-key");

    await expect(resolveAuth("google-gemini-cli", "google", "google:work")).resolves.toBe(
      "google:work",
    );

    mocks.profiles["google:work"] = oauth("google");
    await expect(resolveAuth("google-gemini-cli", "google", "google:work")).rejects.toThrow(
      /cannot use auth profile "google:work"/,
    );
  });

  it("requires a Gemini-native selected profile to be owned by Gemini CLI", async () => {
    mocks.profiles["google-gemini-cli:work"] = createApiKeyCredential(
      "openai",
      "test-wrong-provider-key",
    );
    const resolve = () =>
      resolveAuth("google-gemini-cli", "google-gemini-cli", "google-gemini-cli:work");

    await expect(resolve()).rejects.toThrow(/cannot use auth profile "google-gemini-cli:work"/);

    mocks.profiles["google-gemini-cli:work"] = oauth("google-gemini-cli");
    await expect(resolve()).resolves.toBe("google-gemini-cli:work");
  });

  it("uses the stored owner for a Gemini-native model profile", async () => {
    mocks.profiles["google-gemini-cli:alice"] = oauth("google-gemini-cli");

    await expect(
      resolveAuth("google-gemini-cli", "google", "google-gemini-cli:alice"),
    ).resolves.toBe("google-gemini-cli:alice");
  });
});
