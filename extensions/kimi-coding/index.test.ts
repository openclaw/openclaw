import { describe, expect, it } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import plugin from "./index.js";
import { buildKimiCodingProvider } from "./provider-catalog.js";

describe("kimi-coding plugin", () => {
  it("augments catalog with kimi models", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const entries = await provider.augmentModelCatalog?.({} as never);
    const firstModel = buildKimiCodingProvider().models[0];
    expect(entries).toContainEqual(
      expect.objectContaining({
        provider: "kimi",
        id: firstModel.id,
        name: firstModel.name,
      }),
    );
  });
});
