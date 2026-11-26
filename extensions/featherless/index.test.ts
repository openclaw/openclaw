import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import featherlessPlugin from "./index.js";
import * as models from "./models.js";

describe("featherless provider plugin", () => {
  it("preserves Featherless reasoning during replay", async () => {
    const provider = await registerSingleProviderPlugin(featherlessPlugin);
    const policy = provider.buildReplayPolicy?.({
      provider: "featherless",
      modelApi: "openai-completions",
      modelId: models.FEATHERLESS_DEFAULT_MODEL_ID,
    });
    expect(policy).toBeDefined();
    expect(policy).not.toHaveProperty("dropReasoningFromHistory");
  });
});
