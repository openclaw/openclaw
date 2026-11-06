import { findSourceImportBackedges } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";

describe("OpenAI model construction imports", () => {
  it("loads catalog descriptors without constructing the full provider", async () => {
    expect(
      await findSourceImportBackedges("extensions/openai/provider-discovery.ts", [
        "extensions/openai/openai-provider.ts",
        "extensions/openai/provider-contract-api.ts",
        "extensions/openai/shared.ts",
        "extensions/openai/openai-chatgpt-provider.ts",
      ]),
    ).toEqual([]);
  });

  it("loads model route policy without the transport host", async () => {
    expect(
      await findSourceImportBackedges("extensions/openai/provider-policy-api.ts", [
        "packages/ai/src/host.ts",
      ]),
    ).toEqual([]);
  });

  it("constructs auth descriptors without loading credential stores", async () => {
    expect(
      await findSourceImportBackedges("extensions/openai/openai-provider.ts", [
        "src/agents/auth-profiles/profiles.ts",
        "src/agents/auth-profiles/store.ts",
      ]),
    ).toEqual([]);
  });

  it("registers image policy without loading HTTP dispatchers", async () => {
    expect(
      await findSourceImportBackedges("extensions/openai/image-generation-provider.ts", [
        "src/infra/net/fetch-guard.ts",
      ]),
    ).toEqual([]);
  });

  it.each(["extensions/openai/shared.ts", "src/plugin-sdk/provider-model-metadata.ts"])(
    "%s keeps descriptor construction outside host normalization and discovery",
    async (entry) => {
      expect(
        await findSourceImportBackedges(entry, [
          "src/plugins/provider-model-compat.ts",
          "src/plugins/plugin-metadata-snapshot.ts",
          "src/agents/provider-attribution.ts",
        ]),
      ).toEqual([]);
    },
  );
});
