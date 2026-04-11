import { describe, expect, it } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import servepathPlugin from "./index.js";

describe("servepath provider plugin", () => {
  it("registers the Servepath provider with an implicit catalog", async () => {
    const provider = await registerSingleProviderPlugin(servepathPlugin);

    expect(provider.wizard?.modelPicker).toMatchObject({
      label: "Servepath",
      methodId: "api-key",
    });

    const catalog = await provider.catalog?.run({
      resolveProviderApiKey: () => ({ apiKey: "ts-example" }),
    } as never);

    expect(catalog).toEqual({
      provider: {
        api: "openai-completions",
        apiKey: "ts-example",
        baseUrl: "https://api.servepath.ai",
        models: [
          expect.objectContaining({
            id: "all",
            name: "Servepath Router (alias: servepath)",
            input: ["text", "image"],
          }),
        ],
      },
    });
  });

  it("resolves passthrough models dynamically", async () => {
    const provider = await registerSingleProviderPlugin(servepathPlugin);

    expect(
      provider.resolveDynamicModel?.({
        provider: "servepath",
        modelId: "anthropic/claude-sonnet-4-6",
      } as never),
    ).toMatchObject({
      id: "anthropic/claude-sonnet-4-6",
      provider: "servepath",
      api: "openai-completions",
      baseUrl: "https://api.servepath.ai",
      input: ["text"],
    });
    expect(
      provider.isModernModelRef?.({
        provider: "servepath",
        modelId: "anthropic/claude-sonnet-4-6",
      } as never),
    ).toBe(true);
  });
});
