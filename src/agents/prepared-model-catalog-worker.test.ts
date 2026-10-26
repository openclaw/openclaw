import { describe, expect, it, vi } from "vitest";
import { captureRuntimeConfig } from "../config/runtime-source-projection.js";
import * as cryptoDigest from "../infra/crypto-digest.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { fingerprintPreparedModelCatalogPluginContext } from "./prepared-model-catalog-fingerprints.js";
import { createPreparedModelCatalogWorkerInput } from "./prepared-model-catalog-worker.js";
import { catalogAgentFacts } from "./prepared-model-catalog-worker.shared.test-support.js";

describe("prepared model catalog worker input", () => {
  it("reuses captured config digests for plugin context identities", () => {
    const marker = "synthetic-worker-roster-boundary";
    const digests = vi.spyOn(cryptoDigest, "sha256Base64Url");
    const config = captureRuntimeConfig({
      agents: {
        entries: Object.fromEntries(
          Array.from({ length: 32 }, (_, index) => [`agent-${index}`, { name: marker }]),
        ),
      },
      plugins: { entries: { fixture: { config: { sentinel: undefined } } } },
    });
    const pluginMetadataSnapshot = createPluginMetadataSnapshotFixture();
    const agentFacts = catalogAgentFacts({ config, agentDir: "/tmp/catalog-agent" }, {});
    try {
      let captured: ReturnType<typeof createPreparedModelCatalogWorkerInput> | undefined;
      for (let index = 0; index < 32; index++) {
        captured = createPreparedModelCatalogWorkerInput({
          agentFacts: { ...agentFacts, input: { config, agentDir: `/tmp/catalog-agent-${index}` } },
          pluginMetadataSnapshot,
        });
        fingerprintPreparedModelCatalogPluginContext(captured);
      }
      expect(
        digests.mock.calls.filter(([value]) => typeof value === "string" && value.includes(marker)),
      ).toHaveLength(1);
      const cloned = structuredClone(captured!);
      const fingerprint = fingerprintPreparedModelCatalogPluginContext(captured!);
      expect(
        fingerprintPreparedModelCatalogPluginContext({ ...cloned, pluginMetadataSnapshot }),
      ).toBe(fingerprint);
      const builtInput = createPreparedModelCatalogWorkerInput({
        agentFacts: { ...agentFacts, input: captured!.input },
        pluginMetadataSnapshot,
        preferBuiltPluginArtifacts: true,
      });
      expect(cloned.preferBuiltPluginArtifacts).toBe(false);
      expect(builtInput.preferBuiltPluginArtifacts).toBe(true);
      expect(fingerprintPreparedModelCatalogPluginContext(builtInput)).not.toBe(fingerprint);
      const changedNull = structuredClone(cloned);
      changedNull.input.config.plugins!.entries!.fixture!.config = { sentinel: null };
      expect(
        fingerprintPreparedModelCatalogPluginContext({ ...changedNull, pluginMetadataSnapshot }),
      ).not.toBe(fingerprint);
      cloned.input.config.agents!.entries!["agent-0"]!.name = "changed";
      expect(
        fingerprintPreparedModelCatalogPluginContext({ ...cloned, pluginMetadataSnapshot }),
      ).not.toBe(fingerprint);
    } finally {
      digests.mockRestore();
    }
  });
});
