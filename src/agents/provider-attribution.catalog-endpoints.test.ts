// Verifies catalog-backed endpoint classification for externalized official providers.
import { describe, expect, it } from "vitest";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";

// Prepare the built catalog and installed manifest facts at the owner boundary.
const metadata = createPluginMetadataSnapshotFixture({
  plugins: [
    {
      id: "installed-conflict-fixture",
      providerEndpoints: [
        { endpointClass: "openai-public", hosts: ["coding.dashscope.aliyuncs.com"] },
      ],
    },
  ],
});

import { resolveProviderRequestCapabilities } from "./provider-attribution.js";

describe("catalog-backed provider endpoint classification", () => {
  it.each(["https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"])(
    "resolves Token Plan request capabilities for %s",
    (baseUrl) => {
      const capabilities = resolveProviderRequestCapabilities({
        provider: "qwen-token-plan",
        providerMetadataOwners: metadata.owners,
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
