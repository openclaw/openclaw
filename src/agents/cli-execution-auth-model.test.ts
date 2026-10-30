import { afterEach, expect, it } from "vitest";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { testing as cliBackendsTesting } from "./cli-backends.test-support.js";
import { resolveCliExecutionAuthProfileId } from "./cli-execution-auth.js";

afterEach(() => cliBackendsTesting.resetDepsForTest());

it("orders fresh CLI accounts for the requested model while retaining session accounts", async () => {
  cliBackendsTesting.setDepsForTest({
    resolveRuntimeCliBackends: () => [
      {
        id: "claude-cli",
        modelProvider: "anthropic",
        pluginId: "anthropic",
        config: { command: "claude" },
      },
    ],
    resolvePluginSetupCliBackend: () => undefined,
  });
  const store: AuthProfileStore = {
    version: 1,
    profiles: {
      "claude-cli:first": { type: "token", provider: "claude-cli", token: "synthetic-first" },
      "claude-cli:second": { type: "token", provider: "claude-cli", token: "synthetic-second" },
    },
    order: { "claude-cli": ["claude-cli:first", "claude-cli:second"] },
    usageStats: {
      "claude-cli:first": {
        blockedUntil: Date.now() + 60_000,
        blockedScope: "model",
        blockedModel: "limited",
        blockedReason: "subscription_limit",
      },
    },
  };
  const params = {
    cliExecutionProvider: "claude-cli",
    authProfileProvider: "anthropic",
    config: {},
    agentDir: "/unused-quota-fixture",
    loadAuthProfileStoreForRuntimeAsync: async () => store,
  };
  expect(await resolveCliExecutionAuthProfileId({ ...params, model: "sibling" })).toBe(
    "claude-cli:first",
  );
  expect(await resolveCliExecutionAuthProfileId({ ...params, model: "limited" })).toBe(
    "claude-cli:second",
  );
  expect(
    await resolveCliExecutionAuthProfileId({
      ...params,
      model: "limited",
      sessionBinding: { sessionId: "existing-session", authProfileId: "claude-cli:first" },
    }),
  ).toBe("claude-cli:first");
  expect(
    await resolveCliExecutionAuthProfileId({
      ...params,
      model: "limited",
      selected: { authProfileId: "claude-cli:first", authProfileIdSource: "user" },
    }),
  ).toBe("claude-cli:first");
});
