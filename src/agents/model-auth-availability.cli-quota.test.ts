import { afterEach, expect, it } from "vitest";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { testing as cliBackendsTesting } from "./cli-backends.test-support.js";
import { createModelAuthAvailabilityResolver } from "./model-auth-availability.js";

afterEach(() => cliBackendsTesting.resetDepsForTest());

it("reports the CLI account available for the requested model without changing stored quota", () => {
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
      first: { type: "token", provider: "claude-cli", token: "synthetic-first" },
      second: { type: "token", provider: "claude-cli", token: "synthetic-second" },
    },
    order: { "claude-cli": ["first", "second"] },
    usageStats: {
      first: {
        blockedUntil: Date.now() + 60_000,
        blockedScope: "model",
        blockedModel: "limited",
        blockedReason: "subscription_limit",
      },
    },
  };
  const before = structuredClone(store);
  const resolver = createModelAuthAvailabilityResolver({ cfg: {}, authStore: store, env: {} });
  expect(
    resolver.evaluateRuntimeModelAuth("anthropic", { runtimeId: "claude-cli", modelId: "limited" }),
  ).toMatchObject({ availability: true, selectedProfileId: "second" });
  expect(
    resolver.evaluateRuntimeModelAuth("anthropic", { runtimeId: "claude-cli", modelId: "sibling" }),
  ).toMatchObject({ availability: true, selectedProfileId: "first" });
  expect(store).toEqual(before);
});
