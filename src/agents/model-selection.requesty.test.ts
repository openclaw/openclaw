import { expect, it } from "vitest";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { resolveModelRefFromString } from "./model-selection-resolve.js";

it("does not advertise regional Requesty policies that lose routing during selection", async () => {
  const { projectRequestyModels } = await loadBundledPluginFacade<{
    projectRequestyModels: (rows: readonly unknown[]) => ModelDefinitionConfig[];
  }>({ pluginId: "requesty", artifactBasename: "api.js" });
  const models = projectRequestyModels([
    { id: "claude-sonnet-4-6", api: "chat" },
    { id: "claude-sonnet-4-6@eu", api: "chat" },
    { id: "bedrock/claude-sonnet-4-6@eu-central-1", api: "chat" },
  ]);
  for (const model of models) {
    expect(
      resolveModelRefFromString({
        raw: `requesty/${model.id}`,
        defaultProvider: "requesty",
        manifestPlugins: [{ providers: ["requesty"] }],
        allowPluginNormalization: false,
      })?.ref,
    ).toEqual({ provider: "requesty", model: model.id });
  }
  expect(models.map((model) => model.id)).toEqual(["claude-sonnet-4-6"]);
});
