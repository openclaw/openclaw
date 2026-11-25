import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
// mock-isolation: fixture ordering avoids consulting runtime auth profile state.
vi.mock("./auth-profiles/order.js", () => ({
  resolveAuthProfileOrderWithMetadata: () => ({ profileIds: mocks.order, hasExplicitOrder: false }),
}));
import { resolveCliExecutionAuthProfileId } from "./cli-execution-auth.js";

const C = "claude-cli";
const G = "google-gemini-cli";
const claude = {
  id: C,
  modelProvider: "anthropic",
  pluginId: "anthropic",
  config: { command: "claude" },
};
function credential(
  provider: string,
  type: "api_key" | "token" | "oauth" = "api_key",
  expires = Date.now() + 60_000,
): AuthProfileCredential {
  if (type === "api_key") {
    return createApiKeyCredential(provider, "test-key");
  }
  if (type === "token") {
    return { type, provider, token: "test-token" };
  }
  return { type, provider, access: "test-access", refresh: "test-refresh", expires };
}
function resolve(
  cliExecutionProvider: string,
  authProfileProvider: string,
  authProfileId: string,
  overrides: Partial<Parameters<typeof resolveCliExecutionAuthProfileId>[0]> = {},
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
beforeEach(() => {
  mocks.order = [];
  mocks.profiles = {};
  cliBackendsTesting.setDepsForTest({
    resolveRuntimeCliBackends: () => [
      claude,
      { id: G, modelProvider: "google", pluginId: G, config: { command: "gemini" } },
    ],
    resolvePluginSetupCliBackend: () => undefined,
  });
});
afterEach(() => cliBackendsTesting.resetDepsForTest());

it.each([
  [C, C, C, "oauth", C, true],
  [G, G, G, "oauth", G, true],
  [G, "google", G, "oauth", G, true],
  [C, "anthropic", "anthropic", "api_key", "anthropic", true],
  [C, "anthropic", "anthropic", "token", "anthropic", true],
  [C, "anthropic", "anthropic", "oauth", "anthropic", true],
  [C, "openai", "openai", "api_key", "openai", false],
  [G, "openai", "openai", "api_key", "openai", false],
  [G, G, "openai", "api_key", G, false],
  [G, "google", "google", "api_key", "google", true],
  [G, "google", "google", "oauth", "google", false],
] satisfies Array<[string, string, string, "api_key" | "token" | "oauth", string, boolean]>)(
  "%s selection %s with %s %s in %s profile: accepted=%s",
  async (cli, provider, owner, type, prefix, accepted) => {
    const id = prefix + ":work";
    mocks.profiles[id] = credential(owner, type);
    const pending = resolve(cli, provider, id);
    if (accepted) {
      await expect(pending).resolves.toBe(id);
    } else {
      await expect(pending).rejects.toThrow('cannot use auth profile "' + id + '"');
    }
  },
);
it.each(["auto", "user"] as const)(
  "ignores retired native Claude credentials selected by %s",
  async (authProfileIdSource) => {
    const id = "anthropic:claude-cli";
    mocks.profiles[id] = credential(C, "oauth", Date.now() - 60_000);
    mocks.order.push(id);
    await expect(
      resolve(C, C, id, { selected: { authProfileId: id, authProfileIdSource } }),
    ).resolves.toBeUndefined();
  },
);
it("resolves canonical Anthropic credentials through the setup registry", async () => {
  cliBackendsTesting.setDepsForTest({
    resolveRuntimeCliBackends: () => [],
    resolvePluginSetupCliBackend: ({ backend }) =>
      backend === C ? { pluginId: "anthropic", backend: claude } : undefined,
  });
  mocks.profiles["anthropic:work"] = credential("anthropic", "token");
  await expect(resolve(C, "anthropic", "anthropic:work")).resolves.toBe("anthropic:work");
});
it("loads a selected personal profile without falling back to ambient Claude", async () => {
  const id = "personal:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222";
  mocks.profiles["claude-cli:ambient"] = credential(C);
  mocks.order.push("claude-cli:ambient");
  await expect(
    resolve(C, "anthropic", id, {
      loadAuthProfileStoreForRuntimeAsync: async (_agentDir, options) => ({
        version: 1,
        profiles: {
          ...mocks.profiles,
          ...(options?.profileId === id ? { [id]: credential("anthropic", "token") } : {}),
        },
      }),
    }),
  ).resolves.toBe(id);
});
it.each(["absent", "auto"] as const)(
  "auto-selects only CLI-owned Claude credentials: %s",
  async (selection) => {
    const selected =
      selection === "auto"
        ? { authProfileId: "anthropic:default", authProfileIdSource: "auto" as const }
        : undefined;
    mocks.profiles["anthropic:default"] = credential("anthropic");
    mocks.order.push("anthropic:default");
    await expect(
      resolve(C, "anthropic", "anthropic:default", { selected }),
    ).resolves.toBeUndefined();
    mocks.profiles["claude-cli:work"] = credential(C);
    mocks.order.push("claude-cli:work");
    await expect(resolve(C, "anthropic", "anthropic:default", { selected })).resolves.toBe(
      "claude-cli:work",
    );
  },
);
it("rejects a missing explicit profile instead of changing identities", async () => {
  await expect(resolve(G, G, G + ":missing")).rejects.toThrow(
    'No credentials found for profile "' + G + ':missing"',
  );
});
