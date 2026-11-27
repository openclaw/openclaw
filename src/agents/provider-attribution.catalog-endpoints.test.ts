// Verifies catalog-backed endpoint classification for externalized official providers.
import { describe, expect, it, vi } from "vitest";

// Simulates a built dist tree: externalized provider metadata comes from the
// catalog alongside installed manifest metadata.
vi.mock("../plugins/plugin-metadata-snapshot-required.js", async (importOriginal) => {
  const { createPluginMetadataSnapshotFixture } =
    await import("../plugins/plugin-metadata.test-support.js");
  return {
    ...(await importOriginal<typeof import("../plugins/plugin-metadata-snapshot-required.js")>()),
    getCurrentPluginMetadataSnapshotRequiredRuntime: () =>
      createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "installed-conflict-fixture",
            providerEndpoints: [
              { endpointClass: "openai-public", hosts: ["coding.dashscope.aliyuncs.com"] },
            ],
          },
        ],
      }),
  };
});

import { resolveProviderRequestCapabilities } from "./provider-attribution.js";

describe("catalog-backed provider endpoint classification", () => {
  it.each(["https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"])(
    "resolves Token Plan request capabilities for %s",
    (baseUrl) => {
      const capabilities = resolveProviderRequestCapabilities({
        provider: "qwen-token-plan",
        api: "openai-completions",
        baseUrl,
        capability: "llm",
        transport: "stream",
      });
      expect(capabilities.endpointClass).toBe("modelstudio-native");
      expect(capabilities.supportsNativeStreamingUsageCompat).toBe(true);
      expect(capabilities.isKnownNativeEndpoint).toBe(true);
    },
  );
});
