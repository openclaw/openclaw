import { findSourceImportBackedges } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it } from "vitest";

const metadataOwners = [
  "src/plugins/provider-model-compat.ts",
  "src/plugins/plugin-metadata-snapshot.ts",
  "src/agents/provider-attribution.ts",
];

it.each(
  Object.entries({
    "extensions/openai/provider-discovery.ts": [
      "extensions/openai/openai-provider.ts",
      "extensions/openai/provider-contract-api.ts",
      "extensions/openai/shared.ts",
      "extensions/openai/openai-chatgpt-provider.ts",
    ],
    "extensions/openai/provider-policy-api.ts": ["packages/ai/src/host.ts"],
    "extensions/openai/openai-provider.ts": [
      "src/agents/auth-profiles/profiles.ts",
      "src/agents/auth-profiles/store.ts",
    ],
    "extensions/openai/image-generation-provider.ts": ["src/infra/net/fetch-guard.ts"],
    "extensions/openai/shared.ts": metadataOwners,
    "src/plugin-sdk/provider-model-metadata.ts": metadataOwners,
  }),
)("%s excludes unrelated runtime owners", async (entry, forbidden) => {
  expect(await findSourceImportBackedges(entry, forbidden)).toEqual([]);
});
