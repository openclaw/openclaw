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
function key(profileId: string, provider: string) {
  mocks.profiles[profileId] = createApiKeyCredential(provider, "test-key");
}

const createBackend = (id: string, modelProvider: string, command: string) => ({
  id,
  modelProvider,
  pluginId: id === "claude-cli" ? "anthropic" : id,
  config: { command },
});
const claude = () => createBackend("claude-cli", "anthropic", "claude");

describe("resolveCliExecutionAuthProfileId", () => {
  beforeEach(() => {
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [
        claude(),
        createBackend("google-gemini-cli", "google", "gemini"),
      ],
      resolvePluginSetupCliBackend: () => undefined,
    });
    mocks.order.length = 0;
    mocks.profiles = {};
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

  it.each([
    ["claude-cli", "claude-cli", "claude-cli:work", "claude-cli"],
    ["google-gemini-cli", "google-gemini-cli", "google-gemini-cli:work", "google-gemini-cli"],
    ["google-gemini-cli", "google", "google-gemini-cli:alice", "google-gemini-cli"],
  ])("%s forwards %s selection %s owned by %s", async (cli, provider, id, owner) => {
    mocks.profiles[id] = oauth(owner);
    await expect(resolveAuth(cli, provider, id)).resolves.toBe(id);
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
            backend === "claude-cli" ? { pluginId: "anthropic", backend: claude() } : undefined,
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
    key("claude-cli:ambient", "claude-cli");
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
      key("anthropic:default", "anthropic");
      mocks.order.push("anthropic:default");

      await expect(
        resolveAuth("claude-cli", "anthropic", "anthropic:default", { selected }),
      ).resolves.toBeUndefined();

      key("claude-cli:work", "claude-cli");
      mocks.order.push("claude-cli:work");

      await expect(
        resolveAuth("claude-cli", "anthropic", "anthropic:default", { selected }),
      ).resolves.toBe("claude-cli:work");
    },
  );

  it.each([
    ["claude-cli", "openai", "openai:work"],
    ["google-gemini-cli", "openai", "openai:work"],
    ["google-gemini-cli", "google-gemini-cli", "google-gemini-cli:work"],
  ])("%s rejects %s selection %s owned by OpenAI", async (cli, provider, id) => {
    key(id, "openai");
    await expect(resolveAuth(cli, provider, id)).rejects.toThrow(`cannot use auth profile "${id}"`);
  });

  it("rejects a missing explicitly selected profile instead of changing identities", async () => {
    await expect(
      resolveAuth("google-gemini-cli", "google-gemini-cli", "google-gemini-cli:missing"),
    ).rejects.toThrow(/No credentials found for profile "google-gemini-cli:missing"/);
  });

  it("bridges only a stored canonical Google API key to Gemini CLI", async () => {
    key("google:work", "google");
    await expect(resolveAuth("google-gemini-cli", "google", "google:work")).resolves.toBe(
      "google:work",
    );

    mocks.profiles["google:work"] = oauth("google");
    await expect(resolveAuth("google-gemini-cli", "google", "google:work")).rejects.toThrow(
      /cannot use auth profile "google:work"/,
    );
  });
});
