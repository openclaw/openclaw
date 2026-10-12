import { describe, expect, it, vi } from "vitest";
import { captureRuntimeConfig } from "../config/runtime-source-projection.js";
import * as cryptoDigest from "../infra/crypto-digest.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { fingerprintPreparedModelCatalogGeneration } from "./prepared-model-catalog-fingerprints.js";
import { createPreparedModelCatalogWorkerInput } from "./prepared-model-catalog-worker.js";
import type { PreparedModelRuntimeAgentFacts } from "./prepared-model-runtime.catalog-contract.js";
import { AuthStorage } from "./sessions/auth-storage.js";

describe("prepared model catalog worker input", () => {
  it("reuses captured config digests while workers independently reconstruct them", () => {
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
    const agentFacts: PreparedModelRuntimeAgentFacts = {
      input: { config, agentDir: "/tmp/catalog-agent" },
      env: {},
      authStore: { version: 1, profiles: {} },
      credentials: {},
      providerIds: [],
      configuredModelRefs: [],
      configuredRuntimeModels: [],
      runtimeCapabilityModels: [],
      configuredGeneratedCatalogPluginIds: [],
      templateAuthStorage: AuthStorage.inMemory({}),
    };
    try {
      let captured: ReturnType<typeof createPreparedModelCatalogWorkerInput> | undefined;
      for (let index = 0; index < 32; index++) {
        captured = createPreparedModelCatalogWorkerInput({
          agentFacts: { ...agentFacts, input: { config, agentDir: `/tmp/catalog-agent-${index}` } },
          pluginMetadataSnapshot,
        });
      }
      expect(
        digests.mock.calls.filter(([value]) => typeof value === "string" && value.includes(marker)),
      ).toHaveLength(1);
      const cloned = structuredClone(captured!);
      expect(fingerprintPreparedModelCatalogGeneration({ ...cloned, pluginMetadataSnapshot })).toBe(
        captured!.generationFingerprint,
      );
      const builtInput = createPreparedModelCatalogWorkerInput({
        agentFacts: { ...agentFacts, input: captured!.input },
        pluginMetadataSnapshot,
        preferBuiltPluginArtifacts: true,
      });
      expect(cloned.preferBuiltPluginArtifacts).toBe(false);
      expect(builtInput.preferBuiltPluginArtifacts).toBe(true);
      expect(builtInput.generationFingerprint).not.toBe(cloned.generationFingerprint);
      const changedNull = structuredClone(cloned);
      changedNull.input.config.plugins!.entries!.fixture!.config = { sentinel: null };
      expect(
        fingerprintPreparedModelCatalogGeneration({ ...changedNull, pluginMetadataSnapshot }),
      ).not.toBe(captured!.generationFingerprint);
      cloned.input.config.agents!.entries!["agent-0"]!.name = "changed";
      expect(
        fingerprintPreparedModelCatalogGeneration({ ...cloned, pluginMetadataSnapshot }),
      ).not.toBe(captured!.generationFingerprint);
    } finally {
      digests.mockRestore();
    }
  });
});
