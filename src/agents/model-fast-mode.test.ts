import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { createModelSpeedPolicyResolver } from "./model-fast-mode.js";

const opus: ModelCatalogEntry = {
  id: "claude-opus-5",
  name: "Opus 5",
  provider: "anthropic",
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
};
const sonnet = { ...opus, id: "claude-sonnet-5" };
const available = { availability: true, routeResolution: null, selectedAuthMode: "api_key" };
function metadata(providers: string[]) {
  return createPluginMetadataSnapshotFixture({
    plugins: providers.map((id) => ({
      id,
      providers: [id],
      rootDir: path.resolve(import.meta.dirname, "../../extensions", id),
      ...(id === "anthropic"
        ? {
            providerEndpoints: [
              { endpointClass: "anthropic-public", hosts: ["api.anthropic.com"] },
            ],
            providerRequest: { providers: { anthropic: { family: "anthropic" } } },
          }
        : {}),
    })),
  });
}
const openai: ModelCatalogEntry = {
  id: "speed-fixture",
  name: "Speed fixture",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
};
function fastResolver(params: Parameters<typeof createModelSpeedPolicyResolver>[0]) {
  const resolve = createModelSpeedPolicyResolver(params);
  return (...args: Parameters<typeof resolve>) => resolve(...args).supportsFastMode;
}
function resolver(cfg: OpenClawConfig = {}) {
  return fastResolver({
    cfg,
    agentId: "main",
    catalog: [opus],
    metadataSnapshot: metadata(["anthropic"]),
  });
}
describe("private selected Fast metadata", () => {
  it("uses each selected model's policy", () => {
    const catalog: ModelCatalogEntry[] = [
      openai,
      { id: "grok-3", name: "Grok 3", provider: "xai", api: "openai-responses" },
      { id: "MiniMax-M2.7", name: "MiniMax M2.7", provider: "minimax", api: "anthropic-messages" },
    ];
    const resolve = fastResolver({
      cfg: {},
      agentId: "main",
      catalog,
      metadataSnapshot: metadata(["openai", "xai", "minimax"]),
    });
    const expected = [true, undefined];
    expect(
      catalog.map((entry) => [
        resolve(entry, available, "openclaw"),
        resolve(entry, available, "codex"),
      ]),
    ).toEqual([expected, expected, expected]);
  });
  it("loads the provider's light policy for the exact model and auth facts", () => {
    const resolve = resolver();
    expect(resolve(sonnet, available)).toBe(false);
    expect(resolve(opus, available)).toBe(true);
    expect(resolve(opus, { availability: undefined, routeResolution: null })).toBeUndefined();
    expect(resolve(sonnet, { availability: true, routeResolution: null }, "codex")).toBeUndefined();
  });
  it("uses the same model/agent parameter order as request construction", () => {
    const models = { "anthropic/claude-opus-5": { params: { serviceTier: "standard_only" } } };
    const cases: [OpenClawConfig["agents"], boolean][] = [
      [
        {
          defaults: { params: { serviceTier: "auto" } },
          entries: { main: { params: { serviceTier: "invalid" } } },
        },
        true,
      ],
      [{ defaults: { models } }, false],
      [{ entries: { main: { models } } }, false],
    ];
    for (const [agents, expected] of cases) {
      expect(resolver({ agents })(opus, available)).toBe(expected);
    }
  });
  it("does not replace unresolved route ownership with catalog provenance", () => {
    expect(
      resolver()(opus, { availability: undefined, routeResolution: { kind: "indeterminate" } }),
    ).toBeUndefined();
  });
});

it("derives tier recovery from the selected transport rather than catalog provenance", () => {
  const resolve = createModelSpeedPolicyResolver({
    cfg: {},
    agentId: "main",
    catalog: [openai],
    metadataSnapshot: metadata(["openai"]),
  });
  for (const [baseUrl, expected] of [
    ["https://api.openai.com/v1", true],
    ["https://custom.example/v1", false],
    ["https://api.openai.com/proxy", false],
  ] as const) {
    const evaluation = {
      ...available,
      selectedRoute: {
        api: "openai-responses" as const,
        baseUrl,
        authRequirement: "api-key" as const,
        requestTransportOverrides: "none" as const,
      },
    };
    expect(resolve(openai, evaluation, "openclaw").supportsServiceTierRecovery).toBe(expected);
    expect(resolve(openai, evaluation, "codex").supportsServiceTierRecovery).toBe(false);
  }
});
