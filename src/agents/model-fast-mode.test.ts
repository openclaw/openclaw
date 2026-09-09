import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { createModelFastModeResolver } from "./model-fast-mode.js";

const opus: ModelCatalogEntry = {
  id: "claude-opus-5",
  name: "Opus 5",
  provider: "anthropic",
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
};
function resolver(cfg: OpenClawConfig = {}) {
  return createModelFastModeResolver({
    cfg,
    agentId: "main",
    catalog: [opus],
    metadataSnapshot: createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "anthropic",
          providers: ["anthropic"],
          rootDir: path.resolve(import.meta.dirname, "../../extensions/anthropic"),
          providerEndpoints: [{ endpointClass: "anthropic-public", hosts: ["api.anthropic.com"] }],
          providerRequest: { providers: { anthropic: { family: "anthropic" } } },
        },
      ],
    }),
  });
}
describe("private selected Fast metadata", () => {
  it("uses each selected model's policy and effective agent parameters", () => {
    const catalog: ModelCatalogEntry[] = [
      {
        id: "speed-fixture",
        name: "Speed fixture",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      },
      { id: "grok-3", name: "Grok 3", provider: "xai", api: "openai-responses" },
      { id: "MiniMax-M2.7", name: "MiniMax M2.7", provider: "minimax", api: "anthropic-messages" },
    ];
    const resolve = createModelFastModeResolver({
      cfg: {
        agents: {
          entries: {
            main: { models: { "openai/speed-fixture": { params: { serviceTier: "flex" } } } },
          },
        },
      },
      agentId: "main",
      catalog,
      metadataSnapshot: createPluginMetadataSnapshotFixture({
        plugins: ["openai", "xai", "minimax"].map((id) => ({
          id,
          providers: [id],
          rootDir: path.resolve(import.meta.dirname, "../../extensions", id),
        })),
      }),
    });
    const evaluation = { availability: true, routeResolution: null, selectedAuthMode: "api_key" };
    expect(catalog.map((entry) => resolve(entry, evaluation, "openclaw"))).toEqual([
      false,
      true,
      true,
    ]);
    expect(catalog.map((entry) => resolve(entry, evaluation, "codex"))).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });
  it("loads the provider's light policy for the exact model and auth facts", () => {
    const resolve = resolver();
    expect(
      resolve(
        { ...opus, id: "claude-sonnet-5" },
        { availability: true, routeResolution: null, selectedAuthMode: "api_key" },
      ),
    ).toBe(false);
    expect(
      resolve(opus, { availability: true, routeResolution: null, selectedAuthMode: "api_key" }),
    ).toBe(true);
    expect(resolve(opus, { availability: undefined, routeResolution: null })).toBeUndefined();
    expect(
      resolve(
        { ...opus, id: "claude-sonnet-5" },
        { availability: true, routeResolution: null },
        "codex",
      ),
    ).toBeUndefined();
  });
  it("uses the same model/agent parameter order as request construction", () => {
    const resolve = resolver({
      agents: {
        defaults: { params: { serviceTier: "auto" } },
        entries: { main: { params: { serviceTier: "invalid" } } },
      },
    });
    expect(
      resolve(opus, { availability: true, routeResolution: null, selectedAuthMode: "api_key" }),
    ).toBe(true);
    const explicit = resolver({
      agents: {
        defaults: {
          models: { "anthropic/claude-opus-5": { params: { serviceTier: "standard_only" } } },
        },
      },
    });
    expect(
      explicit(opus, { availability: true, routeResolution: null, selectedAuthMode: "api_key" }),
    ).toBe(false);
  });
  it("does not replace unresolved route ownership with catalog provenance", () => {
    expect(
      resolver()(opus, { availability: undefined, routeResolution: { kind: "indeterminate" } }),
    ).toBeUndefined();
  });
});
