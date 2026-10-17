import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prepareModelSelectionRuntime } from "../auto-reply/reply/model-runtime-normalization.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { AgentHarness } from "./harness/types.js";
import type { ModelCatalogEntry } from "./model-catalog.js";
import { preparePublishedModelRuntimeChoice } from "./model-runtime-choice.js";
import { createModelRuntimeChoiceOwnerFixture } from "./model-runtime-choice.test-support.js";
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
afterEach(() => vi.unstubAllEnvs());
const request = { agentId: "main", provider: "fixture", model: "model" };
const fixtureRow = { provider: "fixture", id: "model", name: "Model", reasoning: false };
const catalog = (...entries: ModelCatalogEntry[]) => ({ entries, routeVariants: entries });
const runtimeConfig = (key: string, id: string): OpenClawConfig => ({
  agents: { defaults: { models: { [key]: { agentRuntime: { id } } } } },
});
function harnessRegistry(...harnesses: AgentHarness[]) {
  const registry = createEmptyPluginRegistry();
  registry.agentHarnesses.push(
    ...harnesses.map((harness) => ({ pluginId: harness.id, source: "fixture", harness })),
  );
  return registry;
}
const harness = (id: string, overrides: Partial<AgentHarness>): AgentHarness => ({
  id,
  label: id,
  authBootstrap: "harness",
  supports: () => ({ supported: true }),
  runAttempt: vi.fn(),
  ...overrides,
});
const custom: OpenClawConfig = {
  plugins: { enabled: false },
  models: {
    providers: {
      fixture: { api: "openai-completions", baseUrl: "https://custom.invalid/v1", models: [] },
    },
  },
};
function publishKeyless(
  config: OpenClawConfig,
  facts: Parameters<typeof createModelRuntimeChoiceOwnerFixture>[2] = {},
  isCurrent = () => true,
) {
  const owner = createModelRuntimeChoiceOwnerFixture(config, isCurrent, facts);
  bindPreparedModelRuntimeAuth(owner, { store: { version: 1, profiles: {} } });
  published.owner = owner;
  return owner;
}
const selectRuntime = (
  options: Omit<Parameters<typeof prepareModelSelectionRuntime>[0], keyof typeof request> &
    Partial<typeof request>,
) => prepareModelSelectionRuntime({ ...request, ...options });
const selectPublished = (cfg: OpenClawConfig, runtimeId = "openclaw", model = request.model) =>
  preparePublishedModelRuntimeChoice({ ...request, cfg, runtimeId, model });

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
    const owner = publishKeyless(cfg);
    const entry = {
      providerOverride: "fixture",
      agentRuntimeOverride: "openclaw",
      ...(inference === "account"
        ? { authProfileOverride: "fixture:missing", authProfileOverrideSource: "user" as const }
        : {}),
    };
    const selection = await selectRuntime({
      cfg,
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

it.each([
  {
    cfg: custom,
    entry: fixtureRow,
    runtimeId: "openclaw",
    message:
      'Runtime "openclaw" is not available for fixture/model: sign-in needed. Connect its provider account, or choose another model.',
  },
  {
    cfg: { plugins: { enabled: false }, ...runtimeConfig("anthropic/*", "claude-cli") },
    entry: { ...fixtureRow, provider: "anthropic", id: "claude-fixture", name: "Claude Fixture" },
    runtimeId: undefined,
    message:
      "A runtime is not available for anthropic/claude-fixture: sign-in needed. If Claude Code is signed out, run claude auth login on the Gateway host, or choose another model.",
  },
])(
  "reports the $entry.provider sign-in action instead of a catalog refresh",
  async ({ cfg, entry, runtimeId, message }) => {
    publishKeyless(cfg, { modelCatalog: catalog(entry) });
    expect(
      await preparePublishedModelRuntimeChoice({
        ...request,
        cfg,
        provider: entry.provider,
        model: entry.id,
        runtimeId,
      }),
    ).toEqual({ kind: "unavailable", message });
  },
);

it("keeps keyless host selection after an explicit runtime reset without granting explicit availability", async () => {
  for (const agentRuntimeOverride of [undefined, "claude-cli"]) {
    expect(
      await selectRuntime({
        cfg: custom,
        catalog: [fixtureRow],
        sessionEntry: { agentRuntimeOverride },
        rawRuntime: agentRuntimeOverride ? "default" : undefined,
      }),
    ).toMatchObject({
      status: "ready",
      runtime: { kind: agentRuntimeOverride ? "clear" : "unchanged" },
    });
  }
  expect(await selectPublished(custom)).toMatchObject({ kind: "unavailable" });
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
      source === "configured" ? runtimeConfig("fixture/model", "native-0") : {};
    const registry = harnessRegistry(
      ...entries.map((entry, i) =>
        harness(`native-${i}`, {
          label: entry.name,
          executionEnvironment: "host-only",
          supports: ({ modelId }) => ({ supported: modelId === entry.id }),
          readModelCatalogReadiness: () => ({ accountType: "oauth", authMode: "oauth" }),
        }),
      ),
    );
    publishKeyless(
      config,
      { pluginRegistry: registry, modelCatalog: catalog(...entries) },
      () => current,
    );
    const checks: Array<() => string | undefined> = [];
    for (const [i, entry] of entries.entries()) {
      const result = await selectRuntime({
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
      if (result.status !== "ready" || !result.validateRuntimeSelection) {
        throw new Error("Native selection missing its commit guard");
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
    await selectRuntime({
      cfg: {},
      sessionEntry: { agentRuntimeOverride: "openclaw" },
      catalog: [fixtureRow],
    }),
  ).toMatchObject({ status: "rejected", reason: "invalid-runtime" });
});

it("validates off-catalog host routes without granting an incompatible runtime", async () => {
  let current = true;
  published.owner = createModelRuntimeChoiceOwnerFixture(custom, () => current);
  const choice = await selectPublished(custom, "openclaw", "off-catalog");
  expect(choice.kind).toBe("ready");
  if (choice.kind !== "ready") {
    throw new Error("Configured route unavailable");
  }
  expect(choice.validate()).toBeUndefined();
  expect(await selectPublished(custom, "codex", "off-catalog")).toMatchObject({
    kind: "unavailable",
  });
  current = false;
  expect(choice.validate()).toContain("not available");
});

it("rejects a stale native observation without renewing it", async () => {
  // This choice also runs inside config write locks; native discovery there needs its own decision.
  const entry = { ...fixtureRow, nativeRuntime: "native-test" };
  const registry = harnessRegistry(
    harness("native-test", {
      label: "Native test",
      // Another agent's turn retired the client that produced this observation.
      readModelCatalogReadiness: () => undefined,
    }),
  );
  const reload = vi.fn(async () => catalog(entry));
  const owner = publishKeyless({}, { pluginRegistry: registry, modelCatalog: catalog(entry) });
  owner.loadNativeModelCatalog = reload;
  expect(await selectPublished({}, "native-test")).toMatchObject({
    kind: "unavailable",
    message: expect.stringContaining("Refresh the model catalog and choose again"),
  });
  expect(reload).not.toHaveBeenCalled();
});
