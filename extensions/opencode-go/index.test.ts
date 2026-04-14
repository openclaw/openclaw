import { describe, expect, it } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import { expectPassthroughReplayPolicy } from "../../test/helpers/provider-replay-policy.ts";
import plugin from "./index.js";

describe("opencode-go provider plugin", () => {
  it("owns passthrough-gemini replay policy for Gemini-backed models", async () => {
    await expectPassthroughReplayPolicy({
      plugin,
      providerId: "opencode-go",
      modelId: "gemini-2.5-pro",
      sanitizeThoughtSignatures: true,
    });
  });

  it("keeps non-Gemini replay policy minimal on passthrough routes", async () => {
    await expectPassthroughReplayPolicy({
      plugin,
      providerId: "opencode-go",
      modelId: "qwen3-coder",
    });
  });

  it("augments the catalog with glm-5.1 from the glm-5 template", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const entries = await provider.augmentModelCatalog?.({
      env: process.env,
      entries: [
        {
          provider: "opencode-go",
          id: "glm-5",
          name: "GLM 5",
          reasoning: true,
          contextWindow: 131072,
          input: ["text"],
        },
      ],
    } as never);

    expect(entries).toEqual([
      {
        provider: "opencode-go",
        id: "glm-5.1",
        name: "GLM 5.1",
        reasoning: true,
        contextWindow: 131072,
        input: ["text"],
      },
    ]);
  });

  it("skips glm-5.1 augmentation when the row already exists", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const entries = await provider.augmentModelCatalog?.({
      env: process.env,
      entries: [
        {
          provider: "opencode-go",
          id: "glm-5",
          name: "GLM 5",
        },
        {
          provider: "opencode-go",
          id: "glm-5.1",
          name: "GLM 5.1",
        },
      ],
    } as never);

    expect(entries).toEqual([]);
  });
});
