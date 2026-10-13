// Verifies CLI runtime alias resolution and runtime model-ref equivalence.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  setRuntimeAuthProfileStoreSnapshot,
} from "./auth-profiles/runtime-snapshots.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { testing as cliBackendsTesting } from "./cli-backends.test-support.js";
import {
  createModelPickerVisibleProviderPredicate,
  isRetiredModelPickerProvider,
  areRuntimeModelRefsEquivalent,
  isCliRuntimeProvider,
  omitCliRuntimeAliasTwins,
  resolveCliRuntimeTwinRoute,
  resolveCliRuntimeExecutionProvider as resolveCliRuntimeExecutionProviderBase,
} from "./model-runtime-aliases.js";
import { prepareOperatorModelPolicy } from "./operator-model-policy.js";

const anthropicAuthAliasMetadata = {
  plugins: [
    {
      id: "anthropic",
      origin: "bundled",
      providerAuthChoices: [
        {
          provider: "anthropic",
          method: "cli",
          choiceId: "anthropic-cli",
          deprecatedChoiceIds: ["claude-cli"],
          choiceLabel: "Anthropic Claude CLI",
        },
      ],
    },
  ],
} as never;

function resolveCliRuntimeExecutionProvider(
  params: Omit<Parameters<typeof resolveCliRuntimeExecutionProviderBase>[0], "metadataSnapshot">,
) {
  return resolveCliRuntimeExecutionProviderBase({
    ...params,
    metadataSnapshot: anthropicAuthAliasMetadata,
  });
}

function createAnthropicAuthConfig(params: {
  order?: string[];
  orderKey?: string;
  onlyCliProfile?: boolean;
  models?: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["models"];
}): OpenClawConfig {
  // Auth order controls whether Anthropic execution is direct API or Claude
  // CLI-backed when no explicit runtime policy overrides it.
  return {
    auth: {
      order: params.order ? { [params.orderKey ?? "anthropic"]: params.order } : undefined,
      profiles: params.onlyCliProfile
        ? { "anthropic:claude-cli": { provider: "claude-cli", mode: "oauth" } }
        : {
            "anthropic:api": { provider: "anthropic", mode: "api_key" },
            "anthropic:claude-cli": { provider: "claude-cli", mode: "oauth" },
          },
    },
    agents: {
      defaults: {
        models: params.models,
      },
    },
  } as OpenClawConfig;
}

describe("resolveCliRuntimeExecutionProvider", () => {
  beforeEach(() => {
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolvePluginSetupRegistry: () => ({
        providers: [],
        cliBackends: [],
        configMigrations: [],
        autoEnableProbes: [],
        diagnostics: [],
      }),
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
    cliBackendsTesting.resetDepsForTest();
    clearRuntimeAuthProfileStoreSnapshots();
  });

  function seedStoredAuthOrder(
    order: string[],
    providerKey = "anthropic",
    profiles: AuthProfileStore["profiles"] = {},
  ): void {
    setRuntimeAuthProfileStoreSnapshot({
      version: 1,
      profiles,
      order: { [providerKey]: order },
    });
  }

  it.each(["pin"])(
    "routes a stored CLI profile selected by %s without config metadata",
    (selection) => {
      seedStoredAuthOrder(selection === "order" ? ["anthropic:claude-cli"] : [], "anthropic", {
        "anthropic:claude-cli": {
          type: "oauth",
          provider: "claude-cli",
          access: "test-access",
          refresh: "test-refresh",
          expires: Date.now() + 60_000,
        },
      });
      expect(
        resolveCliRuntimeExecutionProvider({
          provider: "anthropic",
          modelId: "opus-4.7",
          authProfileId: selection === "pin" ? "anthropic:claude-cli" : undefined,
        }),
      ).toBe("claude-cli");
    },
  );

  it("matches a stored order key that is not already canonically normalized", () => {
    // Persisted state only lowercases provider keys, and the canonical resolver
    // looks the order up through normalized provider matching rather than an exact
    // key hit, so an un-normalized stored key must still beat the config order.
    seedStoredAuthOrder(["anthropic:claude-cli"], "Anthropic");
    expect(
      resolveCliRuntimeExecutionProvider({
        cfg: createAnthropicAuthConfig({ order: ["anthropic:api"] }),
        provider: "anthropic",
        modelId: "opus-4.7",
      }),
    ).toBe("claude-cli");
  });

  it("does not route a provider disabled by an explicitly empty configured order", () => {
    expect(
      resolveCliRuntimeExecutionProvider({
        cfg: createAnthropicAuthConfig({ order: [], onlyCliProfile: true }),
        provider: "anthropic",
        modelId: "opus-4.7",
      }),
    ).toBeUndefined();
  });

  it.each(["stored"])("repairs a %s order containing only deleted profiles", (source) => {
    if (source === "stored") {
      seedStoredAuthOrder(["anthropic:deleted"]);
    }
    expect(
      resolveCliRuntimeExecutionProvider({
        cfg: createAnthropicAuthConfig({
          order: source === "configured" ? ["anthropic:deleted"] : undefined,
          onlyCliProfile: true,
        }),
        provider: "anthropic",
        modelId: "opus-4.7",
      }),
    ).toBe("claude-cli");
  });

  it.each([
    {
      name: "before a configured CLI profile",
      order: ["anthropic:stored-api", "anthropic:claude-cli"],
    },
  ])("keeps a stored profile missing from config authoritative $name", ({ order }) => {
    seedStoredAuthOrder(order, "anthropic", {
      "anthropic:stored-api": { type: "api_key", provider: "anthropic", key: "test-key" },
    });
    expect(
      resolveCliRuntimeExecutionProvider({
        cfg: createAnthropicAuthConfig({ onlyCliProfile: true }),
        provider: "anthropic",
        modelId: "opus-4.7",
      }),
    ).toBeUndefined();
  });

  it("still picks the sole compatible profile when no stored order was authored", () => {
    // Control for the case above: without a stored order the fallback must survive.
    expect(
      resolveCliRuntimeExecutionProvider({
        cfg: createAnthropicAuthConfig({ onlyCliProfile: true }),
        provider: "anthropic",
        modelId: "opus-4.7",
      }),
    ).toBe("claude-cli");
  });

  it("inherits the main-agent stored order for an agent with no snapshot of its own", () => {
    // Named agents inherit auth state from the main agent, and only the main
    // snapshot may be published. An exact-agent lookup would miss it and fall
    // back to config, so the order read resolves inheritance the way
    // getPreparedRuntimeAuthProfileStoreSnapshotCore does.
    seedStoredAuthOrder(["anthropic:claude-cli"]);
    expect(
      resolveCliRuntimeExecutionProvider({
        agentId: "secondary",
        cfg: createAnthropicAuthConfig({}),
        provider: "anthropic",
        modelId: "opus-4.7",
      }),
    ).toBe("claude-cli");
  });

  it("honors an explicit direct Anthropic auth profile over CLI auth order", () => {
    expect(
      resolveCliRuntimeExecutionProvider({
        authProfileId: "anthropic:api",
        cfg: createAnthropicAuthConfig({ order: ["anthropic:claude-cli"] }),
        provider: "anthropic",
        modelId: "opus-4.7",
      }),
    ).toBeUndefined();
  });

  it("does not override an explicit OpenClaw model-runtime policy with CLI auth", () => {
    // Runtime policy is more explicit than profile order, so CLI auth cannot
    // force a model onto the CLI harness when config says OpenClaw.
    expect(
      resolveCliRuntimeExecutionProvider({
        cfg: createAnthropicAuthConfig({
          order: ["anthropic:claude-cli"],
          models: {
            "anthropic/opus-4.7": { agentRuntime: { id: "openclaw" } },
          },
        }),
        provider: "anthropic",
        modelId: "opus-4.7",
      }),
    ).toBeUndefined();
  });

  it("matches provider runtime policy from a provider-qualified model when the caller provider is empty", () => {
    expect(
      resolveCliRuntimeExecutionProvider({
        cfg: {
          models: {
            providers: {
              anthropic: {
                baseUrl: "https://api.anthropic.example/v1",
                agentRuntime: { id: "claude-cli" },
                models: [],
              },
            },
          },
        } as OpenClawConfig,
        provider: "",
        modelId: "anthropic/opus-4.7",
      }),
    ).toBe("claude-cli");
  });

  it("does not return a CLI runtime when the matched entry's provider is incompatible with the runtime alias", () => {
    expect(
      resolveCliRuntimeExecutionProvider({
        cfg: createAnthropicAuthConfig({
          models: {
            "openrouter/opus-4.7": { agentRuntime: { id: "claude-cli" } },
          },
        }),
        provider: "",
        modelId: "opus-4.7",
      }),
    ).toBeUndefined();
  });

  it("keeps standalone CLI backend provider refs visible", () => {
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [
        {
          id: "claude-cli",
          modelProvider: "anthropic",
          pluginId: "anthropic",
          config: { command: "claude" },
        },
        {
          id: "acme-cli",
          pluginId: "acme",
          config: { command: "acme" },
        },
      ],
    });

    const isVisibleProvider = createModelPickerVisibleProviderPredicate();

    expect(isCliRuntimeProvider("claude-cli")).toBe(true);
    expect(isVisibleProvider("claude-cli")).toBe(false);
    expect(isCliRuntimeProvider("acme-cli")).toBe(false);
    expect(isVisibleProvider("acme-cli")).toBe(true);
  });

  it("collapses CLI runtime rows only into a canonical row config pins to that runtime", () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-opus-5": { agentRuntime: { id: "claude-cli" } },
            // Runtime ids are trimmed and lowercased before execution.
            "anthropic/claude-haiku-5": { agentRuntime: { id: " Claude-CLI " } },
          },
        },
      },
    };
    const rows = [
      { provider: "anthropic", id: "claude-opus-5", agentRuntime: { id: "claude-cli" } },
      { provider: "claude-cli", id: "claude-opus-5" },
      { provider: "anthropic", id: "claude-haiku-5", agentRuntime: { id: "claude-cli" } },
      { provider: "claude-cli", id: "claude-haiku-5" },
      // A session runtime override, not config, routes this row through Claude CLI.
      { provider: "anthropic", id: "claude-sonnet-5", agentRuntime: { id: "claude-cli" } },
      { provider: "claude-cli", id: "claude-sonnet-5" },
      { provider: "anthropic", id: "claude-fable-5", agentRuntime: { id: "openclaw" } },
      { provider: "claude-cli", id: "claude-fable-5" },
    ].map((row) => ({
      row,
      twin: resolveCliRuntimeTwinRoute(row, {
        config,
        agentId: "main",
        cliRuntimeBindings: [{ provider: "anthropic", runtime: "claude-cli" }],
      }),
    }));
    const keys = (policies: Parameters<typeof omitCliRuntimeAliasTwins>[1]) =>
      omitCliRuntimeAliasTwins(rows, policies).map((row) => `${row.provider}/${row.id}`);

    expect(keys([])).toEqual([
      "anthropic/claude-opus-5",
      "anthropic/claude-haiku-5",
      "anthropic/claude-sonnet-5",
      "claude-cli/claude-sonnet-5",
      "anthropic/claude-fable-5",
      "claude-cli/claude-fable-5",
    ]);
    // A role that may see only the Claude CLI rows keeps them.
    const cliOnly = prepareOperatorModelPolicy({
      cfg: config,
      policy: { allow: ["claude-cli/*"] },
    });
    if (!cliOnly) {
      throw new Error("expected a Claude CLI role policy");
    }
    expect(keys([cliOnly])).toHaveLength(rows.length);
  });

  it("recognizes retired picker providers without loading CLI backend metadata", () => {
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupRegistry: () => {
        throw new Error("retired provider checks should not load setup metadata");
      },
      resolveRuntimeCliBackends: () => {
        throw new Error("retired provider checks should not load runtime metadata");
      },
    });

    expect(isRetiredModelPickerProvider("CODEX-CLI")).toBe(true);
    expect(isRetiredModelPickerProvider("anthropic")).toBe(false);
  });
});

describe("areRuntimeModelRefsEquivalent", () => {
  afterEach(() => {
    cliBackendsTesting.resetDepsForTest();
  });

  it("does not load setup runtime aliases for already-identical refs", () => {
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupRegistry: () => {
        throw new Error("setup registry should not load for identical refs");
      },
      resolveRuntimeCliBackends: () => [],
    });

    expect(
      areRuntimeModelRefsEquivalent("anthropic/claude", "anthropic/claude", {
        config: {},
      }),
    ).toBe(true);
  });

  it("resolves one setup runtime alias without loading the full setup registry", () => {
    // Equivalence checks use targeted setup lookup so hot model comparisons do
    // not load the full plugin setup registry.
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: ({ backend }) =>
        backend === "claude-cli"
          ? {
              pluginId: "anthropic",
              backend: {
                id: "claude-cli",
                modelProvider: "anthropic",
                config: { command: "claude" },
                bundleMcp: false,
              },
            }
          : undefined,
      resolvePluginSetupRegistry: () => {
        throw new Error("setup registry should not load for a single runtime alias");
      },
      resolveRuntimeCliBackends: () => [],
    });

    expect(
      areRuntimeModelRefsEquivalent("anthropic/claude-opus-4-7", "claude-cli/claude-opus-4-7", {
        config: {},
      }),
    ).toBe(true);
  });
});
