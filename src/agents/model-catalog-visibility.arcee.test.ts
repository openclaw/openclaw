import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { projectModelCatalogEntryForRoute } from "./model-catalog-route.js";
import {
  resolveLogicalModelCatalogEntryState,
  resolveLogicalVisibleModelCatalog,
} from "./model-catalog-visibility.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import {
  openAIModelCatalogRoutePolicy,
  resolveModelCatalogIdentityKey,
} from "./openai-model-routes.js";

const metadata = { name: "Authored default", contextWindow: 32768, reasoning: false };
const authored: ModelCatalogEntry = {
  provider: "arcee",
  id: "arcee-ai/trinity-large-thinking",
  ...metadata,
  api: "openai-completions",
  baseUrl: "https://openrouter.ai/api/v1",
};
const cfg: OpenClawConfig = {
  plugins: { allow: ["arcee"] },
  models: {
    mode: "replace",
    providers: {
      arcee: {
        baseUrl: "https://openrouter.ai/api/v1",
        api: "openai-completions",
        models: [
          {
            id: authored.id,
            ...metadata,
            input: ["text"],
            maxTokens: 2048,
            cost: { input: 7, output: 9, cacheRead: 1, cacheWrite: 2 },
          },
        ],
      },
    },
  },
};

async function project(catalog: ModelCatalogEntry[]) {
  return resolveLogicalVisibleModelCatalog({
    cfg,
    catalog,
    defaultProvider: "arcee",
    defaultModel: "trinity-large-thinking",
    view: "all",
    routePolicy: openAIModelCatalogRoutePolicy,
    evaluateEntry: async () =>
      resolveLogicalModelCatalogEntryState({
        evaluation: { availability: true, routeResolution: null },
        routePolicy: openAIModelCatalogRoutePolicy,
      }),
  });
}

it("keeps logical identity in both public and runtime unmanaged rows", () => {
  const { entry, runtimeEntry } = projectModelCatalogEntryForRoute({
    entry: authored,
    projection: { kind: "unmanaged" },
    overrides: { name: "Selected account model" },
  });

  for (const row of [entry, runtimeEntry]) {
    expect(row).toMatchObject({
      provider: "arcee",
      id: "trinity-large-thinking",
      name: "Selected account model",
      contextWindow: 32768,
    });
  }
  expect(authored).toMatchObject({ id: "arcee-ai/trinity-large-thinking", ...metadata });
});

it.each(["trinity-large-thinking", "arcee-ai/trinity-large-thinking"])(
  "deduplicates %s before authored metadata projection",
  async (id) => {
    const rows = await project([
      authored,
      { ...authored, id, name: "Static sibling", contextWindow: 262144, reasoning: true },
    ]);
    expect(rows).toMatchObject([
      {
        provider: "arcee",
        id: "trinity-large-thinking",
        ...metadata,
      },
    ]);
  },
);
it("keeps unknown model case and separate credential providers distinct", () => {
  const key = (provider: string, id: string) => resolveModelCatalogIdentityKey({ provider, id });
  expect(key("custom", "Reader")).not.toBe(key("custom", "reader"));
  const wireId = "arcee-ai/trinity-large-thinking";
  expect(key("arcee", wireId)).not.toBe(key("openrouter", wireId));
});
