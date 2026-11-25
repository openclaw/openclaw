import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginSetupRegistry } from "../plugins/setup-registry.test-support.js";
import { prepareSharedAuthStoreOwnershipForNative } from "./auth-profiles/path-resolve.native.js";
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

const claudeBackend = {
  id: "claude-cli",
  modelProvider: "anthropic",
  config: { command: "claude" },
};
const claudeBinding = { ...claudeBackend, pluginId: "anthropic" };
const apiProfile = "anthropic:api";
const cliProfile = "anthropic:claude-cli";
function unexpectedMetadata(): never {
  throw new Error("this path must not load CLI metadata");
}
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

type ExecutionRequest = Partial<Parameters<typeof resolveCliRuntimeExecutionProviderBase>[0]>;
function expectExecutionProvider(params: ExecutionRequest, expected: string | undefined) {
  expect(
    resolveCliRuntimeExecutionProviderBase({
      provider: "anthropic",
      modelId: "opus-4.7",
      metadataSnapshot: anthropicAuthAliasMetadata,
      ...params,
    }),
  ).toBe(expected);
}

function createAnthropicAuthConfig(params: {
  order?: string[];
  onlyCliProfile?: boolean;
  models?: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["models"];
}): OpenClawConfig {
  return {
    auth: {
      order: params.order ? { anthropic: params.order } : undefined,
      profiles: {
        ...(!params.onlyCliProfile && {
          [apiProfile]: { provider: "anthropic", mode: "api_key" },
        }),
        [cliProfile]: { provider: "claude-cli", mode: "oauth" },
      },
    },
    agents: { defaults: { models: params.models } },
  } as OpenClawConfig;
}
type AuthConfig = Parameters<typeof createAnthropicAuthConfig>[0];
afterEach(() => {
  cliBackendsTesting.resetDepsForTest();
  clearRuntimeAuthProfileStoreSnapshots();
});

describe("resolveCliRuntimeExecutionProvider", () => {
  beforeEach(() => {
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolvePluginSetupRegistry: () => createEmptyPluginSetupRegistry(),
      resolveRuntimeCliBackends: () => [claudeBinding],
    });
  });

  function seedStoredAuthOrder(
    order: string[],
    providerKey = "anthropic",
    profiles: AuthProfileStore["profiles"] = {},
  ): void {
    prepareSharedAuthStoreOwnershipForNative();
    setRuntimeAuthProfileStoreSnapshot({
      version: 1,
      profiles,
      order: { [providerKey]: order },
    });
  }

  it("routes a stored CLI profile selected by pin without config metadata", () => {
    seedStoredAuthOrder([], "anthropic", {
      [cliProfile]: {
        type: "oauth",
        provider: "claude-cli",
        access: "test-access",
        refresh: "test-refresh",
        expires: Date.now() + 60_000,
      },
    });
    expectExecutionProvider({ authProfileId: cliProfile }, "claude-cli");
  });

  it.each<[string, AuthConfig, string | undefined, (() => void)?, ExecutionRequest?]>([
    [
      "normalized stored order",
      { order: [apiProfile] },
      "claude-cli",
      () => seedStoredAuthOrder([cliProfile], "Anthropic"),
    ],
    ["explicitly disabled order", { order: [], onlyCliProfile: true }, undefined],
    [
      "deleted stored profiles",
      { onlyCliProfile: true },
      "claude-cli",
      () => seedStoredAuthOrder(["anthropic:deleted"]),
    ],
    [
      "stored API profile absent from config",
      { onlyCliProfile: true },
      undefined,
      () =>
        seedStoredAuthOrder(["anthropic:stored-api", cliProfile], "anthropic", {
          "anthropic:stored-api": { type: "api_key", provider: "anthropic", key: "test-key" },
        }),
    ],
    ["sole compatible CLI profile", { onlyCliProfile: true }, "claude-cli"],
    [
      "inherited main-agent order",
      {},
      "claude-cli",
      () => seedStoredAuthOrder([cliProfile]),
      { agentId: "secondary" },
    ],
    [
      "explicit API profile before CLI order",
      { order: [cliProfile] },
      undefined,
      undefined,
      { authProfileId: apiProfile },
    ],
    [
      "explicit host runtime before CLI order",
      {
        order: [cliProfile],
        models: { "anthropic/opus-4.7": { agentRuntime: { id: "openclaw" } } },
      },
      undefined,
    ],
  ])("respects %s", (_name, auth, expected, seed, request) => {
    seed?.();
    expectExecutionProvider({ cfg: createAnthropicAuthConfig(auth), ...request }, expected);
  });

  it("matches provider runtime policy from a provider-qualified model when the caller provider is empty", () => {
    const anthropic = {
      baseUrl: "https://api.anthropic.example/v1",
      agentRuntime: { id: "claude-cli" },
      models: [],
    };
    const cfg: OpenClawConfig = { models: { providers: { anthropic } } };
    expectExecutionProvider(
      {
        cfg,
        provider: "",
        modelId: "anthropic/opus-4.7",
      },
      "claude-cli",
    );
  });

  it("does not return a CLI runtime when the matched entry's provider is incompatible with the runtime alias", () => {
    expectExecutionProvider(
      {
        cfg: createAnthropicAuthConfig({
          models: {
            "openrouter/opus-4.7": { agentRuntime: { id: "claude-cli" } },
          },
        }),
        provider: "",
        modelId: "opus-4.7",
      },
      undefined,
    );
  });

  it.each([undefined, "acme-cli"])(
    "keeps standalone CLI refs visible (binding %s)",
    (modelProvider) => {
      cliBackendsTesting.setDepsForTest({
        resolveRuntimeCliBackends: () => [
          claudeBinding,
          { id: "acme-cli", pluginId: "acme", modelProvider, config: { command: "acme" } },
        ],
      });
      const isVisibleProvider = createModelPickerVisibleProviderPredicate();
      expect(isCliRuntimeProvider("claude-cli")).toBe(true);
      expect(isVisibleProvider("claude-cli")).toBe(false);
      expect(isVisibleProvider("acme-cli")).toBe(true);
    },
  );

  it("recognizes runtime providers without loading unrelated setup backends", () => {
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [
        claudeBinding,
        { id: "standalone-cli", pluginId: "standalone", config: { command: "standalone" } },
      ],
      resolvePluginSetupRegistry: unexpectedMetadata,
      resolvePluginSetupCliBackend: ({ backend }) =>
        backend === "acme-cli"
          ? {
              pluginId: "acme",
              backend: { id: "acme-cli", modelProvider: "acme", config: { command: "acme" } },
            }
          : undefined,
    });

    expect(isCliRuntimeProvider(" Claude-CLI ", { config: {} })).toBe(true);
    expect(isCliRuntimeProvider(" Acme-CLI ", { config: {} })).toBe(true);
    expect(isCliRuntimeProvider("anthropic", { config: {} })).toBe(false);
    expect(isCliRuntimeProvider("standalone-cli", { config: {} })).toBe(false);
    expect(isCliRuntimeProvider("acme-cli")).toBe(false);
  });

  it("collapses CLI runtime rows only into a canonical row config pins to that runtime", () => {
    const models = {
      "anthropic/claude-opus-5": { agentRuntime: { id: "claude-cli" } },
      "anthropic/claude-haiku-5": { agentRuntime: { id: " Claude-CLI " } },
    };
    const config: OpenClawConfig = { agents: { defaults: { models } } };
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
      resolvePluginSetupRegistry: unexpectedMetadata,
      resolveRuntimeCliBackends: unexpectedMetadata,
    });

    expect(isRetiredModelPickerProvider("CODEX-CLI")).toBe(true);
    expect(isRetiredModelPickerProvider("anthropic")).toBe(false);
  });
});

describe("areRuntimeModelRefsEquivalent", () => {
  it("does not load setup runtime aliases for already-identical refs", () => {
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupRegistry: unexpectedMetadata,
      resolveRuntimeCliBackends: () => [],
    });

    expect(
      areRuntimeModelRefsEquivalent("anthropic/claude", "anthropic/claude", {
        config: {},
      }),
    ).toBe(true);
  });

  it("resolves one setup runtime alias without loading the full setup registry", () => {
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: ({ backend }) =>
        backend === "claude-cli"
          ? {
              pluginId: "anthropic",
              backend: { ...claudeBackend, bundleMcp: false },
            }
          : undefined,
      resolvePluginSetupRegistry: unexpectedMetadata,
      resolveRuntimeCliBackends: () => [],
    });

    expect(
      areRuntimeModelRefsEquivalent("anthropic/claude-opus-4-7", "claude-cli/claude-opus-4-7", {
        config: {},
      }),
    ).toBe(true);
  });
});
