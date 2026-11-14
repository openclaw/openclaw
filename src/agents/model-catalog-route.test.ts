import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveThinkingProfile } from "../auto-reply/thinking.js";
import * as activeThinkingPolicy from "../plugins/provider-thinking-active.js";
import { PREPARED_THINKING_POLICY } from "../plugins/provider-thinking-catalog.js";
import type { ProviderDefaultThinkingPolicyContext } from "../plugins/provider-thinking.types.js";
import {
  platformRoute,
  subscriptionRoute as chatGPTRoute,
} from "./model-auth-availability.test-support.js";
import { model, providerConfig } from "./model-catalog-fixtures.test-support.js";
import {
  projectModelCatalogEntryForRoute,
  createConfiguredModelCatalogOverridesResolver,
} from "./model-catalog-route.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { openAIModelCatalogRoutePolicy } from "./openai-model-routes.js";

beforeEach(() => {
  vi.spyOn(openAIModelCatalogRoutePolicy, "resolveIdentity").mockImplementation((entry) => ({
    id: entry.id,
    key: `${entry.provider}/${entry.id}`,
  }));
  vi.spyOn(openAIModelCatalogRoutePolicy, "matchesRoute").mockImplementation(
    (entry, route) => entry.api === route.api && entry.baseUrl === route.baseUrl,
  );
});

const platformEntry: ModelCatalogEntry = {
  provider: "openai",
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: platformRoute.api,
  baseUrl: platformRoute.baseUrl,
  params: { platformOnly: true },
  compat: { supportsTools: false },
};

const chatGPTEntry: ModelCatalogEntry = {
  ...platformEntry,
  api: chatGPTRoute.api,
  baseUrl: chatGPTRoute.baseUrl,
};
const project = (params: Partial<Parameters<typeof projectModelCatalogEntryForRoute>[0]> = {}) =>
  projectModelCatalogEntryForRoute({
    entry: platformEntry,
    projection: { kind: "selected", route: chatGPTRoute },
    ...params,
  });

afterEach(() => vi.restoreAllMocks());
it.each([
  ["subscription", chatGPTRoute, "ultra", "fixture-subscription"],
  ["unresolved", undefined, "off", undefined],
] as const)("retains only the %s route's prepared thinking owner", (_, route, expected, owner) => {
  const resolvePolicy = vi.fn((context: ProviderDefaultThinkingPolicyContext) =>
    context.provider === "fixture-platform"
      ? ({ levels: [{ id: "off" }, { id: "high" }], defaultLevel: "high" } as const)
      : ({
          levels: [{ id: "off" }, { id: "max" }, { id: "ultra" }],
          defaultLevel: "ultra",
        } as const),
  );
  const entry = {
    ...platformEntry,
    thinkingPolicyProvider: "fixture-platform",
    [PREPARED_THINKING_POLICY]: { resolve: resolvePolicy },
  };
  const donor = {
    ...chatGPTEntry,
    thinkingPolicyProvider: "fixture-subscription",
    [PREPARED_THINKING_POLICY]: { resolve: resolvePolicy },
  };
  const ambient = vi
    .spyOn(activeThinkingPolicy, "resolveActiveProviderThinkingProfile")
    .mockReturnValue({ levels: [{ id: "off" }], defaultLevel: "off" });
  const { entry: projected } = project({
    entry,
    projection: route ? { kind: "selected", route } : { kind: "unresolved" },
    catalog: [entry, donor],
  });
  expect(projected).not.toHaveProperty("params");
  expect(projected).not.toHaveProperty("compat");
  expect(
    resolveThinkingProfile({
      provider: projected.provider,
      model: projected.id,
      catalog: [projected],
      agentRuntime: "codex",
      providerPolicySource: "active",
    }).defaultLevel,
  ).toBe(expected);
  if (owner) {
    expect(resolvePolicy).toHaveBeenCalledWith(expect.objectContaining({ provider: owner }));
    expect(ambient).not.toHaveBeenCalled();
  } else {
    expect(resolvePolicy).not.toHaveBeenCalled();
    expect(projected).not.toHaveProperty("thinkingPolicyProvider");
    expect(ambient).toHaveBeenCalledOnce();
  }
});

it("selects logical overrides from a legacy fallback", () => {
  const legacy = model("openai/gpt-5.5", "Legacy row", {
    contextWindow: 900_000,
    contextTokens: 500_000,
    reasoning: true,
    input: ["image"],
    maxTokens: 4096,
  });
  const cfg = providerConfig("openai", { baseUrl: platformRoute.baseUrl, models: [legacy] });
  vi.spyOn(openAIModelCatalogRoutePolicy, "resolveIdentity").mockImplementation((entry) => {
    const id = entry.id.replace(/^openai\//u, "");
    return { id, key: `${entry.provider}/${id}` };
  });

  const resolveOverrides = createConfiguredModelCatalogOverridesResolver({ cfg });
  for (const id of ["gpt-5.5", "openai/gpt-5.5", "gpt-5.5"]) {
    expect(resolveOverrides({ ...platformEntry, id })).toEqual({
      name: "Legacy row",
      reasoning: true,
      configuredReasoning: true,
      input: ["image"],
      contextWindow: 900_000,
      contextTokens: 500_000,
    });
  }
});
