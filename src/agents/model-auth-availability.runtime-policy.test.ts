import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginSetupRegistry } from "../plugins/setup-registry.test-support.js";
import { prepareSharedAuthStoreOwnershipForNative } from "./auth-profiles/path-resolve.native.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  setRuntimeAuthProfileStoreSnapshot,
} from "./auth-profiles/runtime-snapshots.js";
import { testing as cliBackendsTesting } from "./cli-backends.test-support.js";
import * as harnessPolicy from "./harness/policy.js";
import { createModelAuthAvailabilityResolver } from "./model-auth-availability.js";
import { modelDefinition } from "./model-auth.fixtures.test-support.js";
import * as runtimeAliases from "./model-runtime-aliases.js";

const authStore = { version: 1 as const, profiles: {} };
const metadataSnapshot = createPluginMetadataSnapshotFixture();
const route = {
  modelId: "model-99",
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
};

beforeEach(() => {
  prepareSharedAuthStoreOwnershipForNative();
  setRuntimeAuthProfileStoreSnapshot(authStore);
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupCliBackend: () => undefined,
    resolvePluginSetupRegistry: () => createEmptyPluginSetupRegistry(),
    resolveRuntimeCliBackends: () => [
      {
        id: "claude-cli",
        modelProvider: "anthropic",
        pluginId: "anthropic",
        config: { command: "claude" },
      },
    ],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  cliBackendsTesting.resetDepsForTest();
  clearRuntimeAuthProfileStoreSnapshots();
});

it("resolves authored model rows once through actual automatic CLI fallback", () => {
  let modelIdReads = 0;
  const models = Array.from({ length: 100 }, (_, index) => ({
    ...modelDefinition(`model-${index}`),
    get id() {
      modelIdReads++;
      return `model-${index}`;
    },
  }));
  const cfg: OpenClawConfig = {
    models: {
      providers: {
        anthropic: { api: "anthropic-messages", baseUrl: route.baseUrl, models },
      },
    },
  };
  const resolver = createModelAuthAvailabilityResolver({
    cfg,
    agentId: "main",
    authStore,
    metadataSnapshot,
    env: {},
  });
  const harness = vi.spyOn(harnessPolicy, "resolveAgentHarnessPolicy");
  const execution = vi.spyOn(runtimeAliases, "resolveCliRuntimeExecutionProvider");
  modelIdReads = 0;

  const evaluation = resolver.evaluateRuntimeModelAuth(" AnThRoPiC ", route);
  expect(evaluation).toMatchObject({ availability: undefined, routeResolution: null });
  expect(harness).toHaveReturnedWith({ runtime: "auto", runtimeSource: "implicit" });
  expect(execution).toHaveBeenCalledTimes(1);
  expect(modelIdReads).toBe(100);

  execution.mockClear();
  modelIdReads = 0;
  expect(resolver.evaluateRuntimeModelAuth("anthropic", { ...route, runtimeId: "auto" })).toEqual(
    evaluation,
  );
  expect(execution).toHaveBeenCalledTimes(1);
  expect(modelIdReads).toBe(100);

  execution.mockClear();
  modelIdReads = 0;
  expect(
    resolver.evaluateRuntimeModelAuth("anthropic", { ...route, runtimeId: "openclaw" })
      .routeResolution,
  ).toBe(null);
  expect(execution).not.toHaveBeenCalled();
  expect(modelIdReads).toBe(0);
});

it("keeps missing selected profiles terminal despite prepared native CLI authentication", () => {
  const cfg: OpenClawConfig = {
    agents: {
      defaults: { models: { "anthropic/model-99": { agentRuntime: { id: "claude-cli" } } } },
    },
    auth: {
      profiles: {
        "anthropic:api": { provider: "anthropic", mode: "api_key" },
        "anthropic:claude-cli": { provider: "claude-cli", mode: "oauth" },
      },
      order: { anthropic: ["anthropic:api"] },
    },
  };
  const resolver = createModelAuthAvailabilityResolver({
    cfg,
    agentId: "main",
    authStore: {
      version: 1,
      profiles: {
        "anthropic:api": { type: "api_key", provider: "anthropic", key: "synthetic-api-key" },
      },
    },
    metadataSnapshot,
    env: {},
    preparedRuntimeAuthModes: { "claude-cli": { source: "native", mode: "oauth" } },
    preparedSyntheticAuthComplete: true,
  });

  expect(
    resolver.evaluateRuntimeModelAuth("anthropic", {
      ...route,
      pinnedProfileId: "anthropic:missing",
    }).availability,
  ).toBe(false);
  expect(
    resolver.evaluateRuntimeModelAuth("anthropic", {
      ...route,
      requiredProfileId: "anthropic:missing",
    }).availability,
  ).toBe(false);
  expect(
    resolver.evaluateRuntimeModelAuth("anthropic", {
      ...route,
      pinnedProfileId: "anthropic:claude-cli",
    }),
  ).toMatchObject({
    availability: true,
    routeResolution: null,
    runtimeAuth: { id: "claude-cli", source: "native" },
  });
});
