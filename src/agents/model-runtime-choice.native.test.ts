import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prepareModelSelectionRuntime } from "../auto-reply/reply/model-runtime-normalization.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createDeferredCore } from "../shared/deferred.js";
import { testing as cliBackendsTesting } from "./cli-backends.test-support.js";
import type { ModelCatalogEntry } from "./model-catalog.js";
import { prepareModelChoice, preparePublishedModelRuntimeChoice } from "./model-runtime-choice.js";
import { createModelRuntimeChoiceOwnerFixture } from "./model-runtime-choice.test-support.js";
import { bindPreparedModelRuntimeAuth } from "./prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.types.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

const published = vi.hoisted((): { owner?: PreparedModelRuntimeSnapshot } => ({}));
vi.mock("./prepared-model-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./prepared-model-catalog.js")>()),
  getPublishedPreparedModelCatalogOwnerSnapshot: () => published.owner,
  materializePreparedModelCatalogOwner: (owner: PreparedModelRuntimeSnapshot) => owner,
  loadProviderScopedThinkingCatalog: async () => {
    if (!published.owner) {
      throw new Error("No published test model owner");
    }
    return published.owner.modelCatalog.entries;
  },
  withPreparedModelCatalogOwner: async <T>(
    _params: unknown,
    read: (owner: PreparedModelRuntimeSnapshot) => T | Promise<T>,
  ) => {
    if (!published.owner) {
      throw new Error("No published test model owner");
    }
    return await read(published.owner);
  },
}));
beforeEach(() => {
  published.owner = undefined;
});
afterEach(() => {
  cliBackendsTesting.resetDepsForTest();
  vi.unstubAllEnvs();
});
const request = { agentId: "main", provider: "fixture", model: "model" };
const custom: OpenClawConfig = {
  plugins: { enabled: false },
  models: {
    providers: {
      fixture: {
        api: "openai-completions",
        baseUrl: "https://custom.invalid/v1",
        models: [],
      },
    },
  },
};

it.each([
  ["published", "before request"],
  ["published", "after response"],
  ["support", "before request"],
  ["support", "after response"],
] as const)("revalidates %s off-catalog discovery authority %s", async (entrypoint, revocation) => {
  let current = revocation !== "before request";
  const started = createDeferredCore();
  const finish = createDeferredCore();
  const model = makeProviderModelFixture({
    provider: "fixture",
    id: "off-catalog",
    api: "openai-responses",
    baseUrl: "https://dynamic.invalid/v1",
  });
  const prepareDynamicModel = vi.fn(async () => {
    started.resolve();
    if (revocation === "after response") {
      await finish.promise;
    }
    return model;
  });
  const registry = createEmptyPluginRegistry();
  registry.providers.push({
    pluginId: "fixture",
    source: "fixture",
    provider: { id: "fixture", label: "Fixture", auth: [], prepareDynamicModel },
  });
  const cfg: OpenClawConfig = {};
  published.owner = createModelRuntimeChoiceOwnerFixture(cfg, () => current, {
    pluginRegistry: registry,
    modelCatalog: { entries: [], routeVariants: [] },
    metadataSnapshot: createPluginMetadataSnapshotFixture({
      plugins: [{ id: "fixture", providers: ["fixture"] }],
    }),
  });
  const choice =
    entrypoint === "published"
      ? preparePublishedModelRuntimeChoice({
          ...request,
          cfg,
          model: "off-catalog",
          runtimeId: "openclaw",
        })
      : prepareModelChoice({
          cfg,
          agentId: "main",
          raw: "fixture/off-catalog",
          source: "override",
        });
  const unavailable =
    entrypoint === "published"
      ? expect(choice).rejects.toThrow("Model catalog changed")
      : expect(choice).resolves.toMatchObject({
          kind: "unavailable",
          error: "Model configuration changed during selection. Retry the request.",
        });
  if (revocation === "after response") {
    await Promise.race([started.promise, choice]);
    current = false;
    finish.resolve();
  }
  await unavailable;
  expect(prepareDynamicModel).toHaveBeenCalledTimes(revocation === "before request" ? 0 : 1);
});

it.each(["worker", "gateway", "optional", "account"] as const)(
  "admits an explicit keyless OpenClaw selection only for required worker inference (%s)",
  async (inference) => {
    const cfg: OpenClawConfig = {
      ...custom,
      cloudWorkers: {
        ...(inference !== "optional" ? { requiredProfile: "node" } : {}),
        profiles: {
          node: {
            provider: "device",
            settings: {
              device: "node-b",
              inference: inference === "gateway" ? "gateway" : "worker",
            },
          },
        },
      },
    };
    const owner = createModelRuntimeChoiceOwnerFixture(cfg);
    bindPreparedModelRuntimeAuth(owner, { store: { version: 1, profiles: {} } });
    published.owner = owner;
    const entry: SessionEntry = {
      sessionId: "worker-session",
      updatedAt: 0,
      providerOverride: "fixture",
      modelOverride: "model",
      agentRuntimeOverride: "openclaw",
      ...(inference === "account"
        ? { authProfileOverride: "fixture:missing", authProfileOverrideSource: "user" as const }
        : {}),
    };
    const selection = await prepareModelSelectionRuntime({
      cfg,
      ...request,
      rawRuntime: "openclaw",
      sessionEntry: entry,
      catalog: owner.modelCatalog.entries,
      hydrateThinkingCatalog: false,
    });
    expect(selection.status).toBe(inference === "worker" ? "ready" : "rejected");
    if (selection.status === "ready") {
      expect(selection.runtime).toEqual({ kind: "set", runtime: "openclaw" });
      expect(selection.validateRuntimeSelection?.()).toBeUndefined();
    } else {
      expect(selection.message).toContain('Runtime "openclaw" is not available');
    }
  },
);

it("reports missing sign-in instead of a catalog refresh", async () => {
  const owner = createModelRuntimeChoiceOwnerFixture(custom);
  bindPreparedModelRuntimeAuth(owner, { store: { version: 1, profiles: {} } });
  published.owner = owner;
  const selection = await preparePublishedModelRuntimeChoice({
    ...request,
    cfg: custom,
    runtimeId: "openclaw",
  });
  expect(selection).toEqual({
    kind: "unavailable",
    message:
      'Runtime "openclaw" is not available for fixture/model: sign-in needed. Connect its provider account, or choose another model.',
  });
});

it("keeps the configured Claude CLI runtime when switching models with saved setup tokens", async () => {
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  cliBackendsTesting.setDepsForTest({
    resolveRuntimeCliBackends: () => [
      {
        id: "claude-cli",
        modelProvider: "anthropic",
        pluginId: "anthropic",
        config: { command: "claude" },
      },
    ],
  });
  const entry: ModelCatalogEntry = {
    provider: "anthropic",
    id: "claude-sonnet-5",
    name: "Claude Sonnet",
    api: "anthropic-messages",
  };
  const cfg: OpenClawConfig = {
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-opus-5" },
        models: { "anthropic/*": { agentRuntime: { id: "claude-cli" } } },
      },
    },
  };
  const owner = createModelRuntimeChoiceOwnerFixture(cfg, undefined, {
    modelCatalog: { entries: [entry], routeVariants: [entry] },
    authModes: {},
    metadataSnapshot: createPluginMetadataSnapshotFixture({
      plugins: [{ id: "anthropic", providers: ["anthropic"], cliBackends: ["claude-cli"] }],
    }),
  });
  bindPreparedModelRuntimeAuth(owner, {
    store: {
      version: 1,
      profiles: {
        first: { type: "token", provider: "anthropic", token: "synthetic-first-token" },
        second: { type: "token", provider: "anthropic", token: "synthetic-second-token" },
      },
    },
  });
  published.owner = owner;
  const selection = await prepareModelSelectionRuntime({
    cfg,
    agentId: "main",
    provider: entry.provider,
    model: entry.id,
    sessionEntry: { modelProvider: "anthropic" },
    catalog: [entry],
    hydrateThinkingCatalog: false,
  });
  expect(selection).toMatchObject({
    status: "ready",
    runtime: { kind: "set", runtime: "claude-cli" },
  });
});

it("points a signed-out Claude CLI route at claude auth login", async () => {
  const entry: ModelCatalogEntry = {
    provider: "anthropic",
    id: "claude-fixture",
    name: "Claude Fixture",
    reasoning: false,
  };
  const cfg: OpenClawConfig = {
    plugins: { enabled: false },
    agents: { defaults: { models: { "anthropic/*": { agentRuntime: { id: "claude-cli" } } } } },
  };
  const owner = createModelRuntimeChoiceOwnerFixture(cfg, undefined, {
    modelCatalog: { entries: [entry], routeVariants: [entry] },
  });
  bindPreparedModelRuntimeAuth(owner, { store: { version: 1, profiles: {} } });
  published.owner = owner;
  const selection = await preparePublishedModelRuntimeChoice({
    cfg,
    agentId: "main",
    provider: "anthropic",
    model: "claude-fixture",
  });
  expect(selection).toEqual({
    kind: "unavailable",
    message:
      "A runtime is not available for anthropic/claude-fixture: sign-in needed. If Claude Code is signed out, run claude auth login on the Gateway host, or choose another model.",
  });
});

it("keeps keyless host selection after an explicit runtime reset without granting explicit availability", async () => {
  for (const agentRuntimeOverride of [undefined, "claude-cli"]) {
    expect(
      await prepareModelSelectionRuntime({
        ...request,
        cfg: custom,
        catalog: [{ provider: "fixture", id: "model", name: "Model", reasoning: false }],
        sessionEntry: { agentRuntimeOverride },
        rawRuntime: agentRuntimeOverride ? "default" : undefined,
      }),
    ).toMatchObject({
      status: "ready",
      runtime: {
        kind: agentRuntimeOverride ? "clear" : "unchanged",
      },
    });
  }
  expect(
    await preparePublishedModelRuntimeChoice({
      ...request,
      cfg: custom,
      runtimeId: "openclaw",
    }),
  ).toMatchObject({ kind: "unavailable" });
});

it.each(["configured", "literal"] as const)(
  "selects the exact native owner from %s facts and revokes its commit guard",
  async (source) => {
    let current = true;
    const entries = (source === "literal" ? ["model", "fixture/model"] : ["model"]).map((id, i) => {
      const entry: ModelCatalogEntry = { provider: "fixture", id, name: id, reasoning: false };
      if (source !== "configured") {
        entry.nativeRuntime = `native-${i}`;
      }
      return entry;
    });
    const config: OpenClawConfig =
      source === "configured"
        ? {
            agents: {
              defaults: { models: { "fixture/model": { agentRuntime: { id: "native-0" } } } },
            },
          }
        : {};
    const registry = createEmptyPluginRegistry();
    for (const [i, entry] of entries.entries()) {
      registry.agentHarnesses.push({
        pluginId: `native-${i}`,
        source: "fixture",
        harness: {
          id: `native-${i}`,
          label: entry.name,
          authBootstrap: "harness",
          executionEnvironment: "host-only",
          supports: ({ modelId }) => ({ supported: modelId === entry.id }),
          readModelCatalogReadiness: () => ({ accountType: "oauth", authMode: "oauth" }),
          runAttempt: vi.fn(),
        },
      });
    }
    const owner = createModelRuntimeChoiceOwnerFixture(config, () => current, {
      pluginRegistry: registry,
      modelCatalog: { entries, routeVariants: entries },
    });
    bindPreparedModelRuntimeAuth(owner, { store: { version: 1, profiles: {} } });
    published.owner = owner;
    const checks: Array<() => string | undefined> = [];
    for (const [i, entry] of entries.entries()) {
      const result = await prepareModelSelectionRuntime({
        ...request,
        cfg: config,
        model: entry.id,
        catalog: entries,
        thinkingPolicyRequired: false,
      });
      expect(result).toMatchObject({
        status: "ready",
        runtime: { kind: "set", runtime: `native-${i}` },
        harness: { id: `native-${i}`, executionEnvironment: "host-only", label: entry.name },
      });
      if (result.status !== "ready") {
        throw new Error("Native selection failed");
      }
      if (!result.validateRuntimeSelection) {
        throw new Error("Missing commit guard");
      }
      expect(result.validateRuntimeSelection()).toBeUndefined();
      checks.push(result.validateRuntimeSelection);
    }
    current = false;
    for (const validate of checks) {
      expect(validate()).toContain("not available");
    }
  },
);

it("does not let a retained host pin bypass a forced unavailable native runtime", async () => {
  vi.stubEnv("OPENCLAW_BUILD_PRIVATE_QA", "1");
  vi.stubEnv("OPENCLAW_QA_FORCE_RUNTIME", "codex");
  expect(
    await prepareModelSelectionRuntime({
      ...request,
      cfg: {},
      sessionEntry: { agentRuntimeOverride: "openclaw" },
      catalog: [{ provider: "fixture", id: "model", name: "Model", reasoning: false }],
    }),
  ).toMatchObject({ status: "rejected", reason: "invalid-runtime" });
});

it("validates off-catalog host routes without granting an incompatible runtime", async () => {
  let current = true;
  published.owner = createModelRuntimeChoiceOwnerFixture(custom, () => current);
  const choice = await preparePublishedModelRuntimeChoice({
    ...request,
    cfg: custom,
    model: "off-catalog",
    runtimeId: "openclaw",
  });
  expect(choice.kind).toBe("ready");
  if (choice.kind !== "ready") {
    throw new Error("Configured route unavailable");
  }
  expect(choice.validate()).toBeUndefined();
  expect(
    await preparePublishedModelRuntimeChoice({
      ...request,
      cfg: custom,
      model: "off-catalog",
      runtimeId: "codex",
    }),
  ).toMatchObject({ kind: "unavailable" });
  current = false;
  expect(choice.validate()).toContain("not available");
});

it("rejects a stale native observation without renewing it", async () => {
  // This choice also runs inside config write locks; native discovery there needs its own decision.
  const entry: ModelCatalogEntry = {
    provider: "fixture",
    id: "model",
    name: "Model",
    reasoning: false,
    nativeRuntime: "native-test",
  };
  const registry = createEmptyPluginRegistry();
  registry.agentHarnesses.push({
    pluginId: "native-test",
    source: "fixture",
    harness: {
      id: "native-test",
      label: "Native test",
      authBootstrap: "harness",
      supports: () => ({ supported: true }),
      // Another agent's turn retired the client that produced this observation.
      readModelCatalogReadiness: () => undefined,
      runAttempt: vi.fn(),
    },
  });
  const reload = vi.fn(async () => ({ entries: [entry], routeVariants: [entry] }));
  const owner = {
    ...createModelRuntimeChoiceOwnerFixture({}, () => true, {
      pluginRegistry: registry,
      modelCatalog: { entries: [entry], routeVariants: [entry] },
    }),
    loadNativeModelCatalog: reload,
  };
  bindPreparedModelRuntimeAuth(owner, { store: { version: 1, profiles: {} } });
  published.owner = owner;
  expect(
    await preparePublishedModelRuntimeChoice({ ...request, cfg: {}, runtimeId: "native-test" }),
  ).toMatchObject({
    kind: "unavailable",
    message: expect.stringContaining("Refresh the model catalog and choose again"),
  });
  expect(reload).not.toHaveBeenCalled();
});
