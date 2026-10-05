import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prepareModelSelectionRuntime } from "../auto-reply/reply/model-runtime-normalization.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createModelCatalogDecisions } from "./model-catalog-decisions.js";
import type { ModelCatalogEntry } from "./model-catalog.js";
import { preparePublishedModelRuntimeChoice } from "./model-runtime-choice.js";
import {
  createModelRuntimeChoiceOwnerFixture,
  createCustomNativeCommandChoiceFixture,
} from "./model-runtime-choice.test-support.js";
import { bindPreparedModelRuntimeAuth } from "./prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.types.js";

const published = vi.hoisted((): { owner?: PreparedModelRuntimeSnapshot } => ({}));
vi.mock("./prepared-model-catalog.js", () => ({
  getPublishedPreparedModelCatalogOwnerSnapshot: () => published.owner,
  materializePreparedModelCatalogOwner: (owner: PreparedModelRuntimeSnapshot) => owner,
  loadProviderScopedThinkingCatalog: async () => {
    if (!published.owner) {
      throw new Error("No published test model owner");
    }
    return published.owner.modelCatalog.entries;
  },
}));
beforeEach(() => {
  published.owner = undefined;
});
afterEach(() => {
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

it.each(["unowned", "owned", "ambiguous", "host-auth", "transport"] as const)(
  "admits a configured custom Codex route only under its captured ownership/auth contract: %s",
  async (condition) => {
    let current = true;
    const { cfg, provider, model, entry, metadataSnapshot, pluginRegistry, owner } =
      await createCustomNativeCommandChoiceFixture(condition, () => current);
    published.owner = owner;
    const decisions = createModelCatalogDecisions({
      cfg,
      agentId: "main",
      metadataSnapshot,
      snapshot: owner.modelCatalog,
      preparedAuthStore: { version: 1, profiles: {} },
      pluginRegistry,
      isCurrent: owner.isCurrent,
    });
    const choices = decisions.runtimeChoices(entry);
    const result = await prepareModelSelectionRuntime({
      cfg,
      agentId: "main",
      provider,
      model,
      catalog: [entry],
      hydrateThinkingCatalog: false,
    });
    if (condition !== "unowned") {
      expect(choices).not.toContain("codex");
      if (condition !== "host-auth") {
        expect(result).toMatchObject({ status: "rejected", reason: "invalid-runtime" });
      }
      expect(
        await preparePublishedModelRuntimeChoice({
          cfg,
          agentId: "main",
          provider,
          model,
          runtimeId: "codex",
        }),
      ).toMatchObject({ kind: "unavailable" });
      return;
    }
    expect(decisions.evaluateEntry(entry, [entry], "codex")).toMatchObject({
      availability: true,
      selectedAuthMode: "native-command",
      runtimeAuth: { id: "codex" },
    });
    expect(choices).toEqual(["codex"]);
    expect(result).toMatchObject({ status: "ready", runtime: { kind: "set", runtime: "codex" } });
    if (result.status !== "ready" || !result.validateRuntimeSelection) {
      throw new Error("The custom native route did not prepare session runtime admission");
    }
    expect(result.validateRuntimeSelection()).toBeUndefined();
    current = false;
    expect(result.validateRuntimeSelection()).toContain("not available");
    expect(() => decisions.runtimeChoices(entry)).toThrow("Model catalog changed");
  },
);

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
