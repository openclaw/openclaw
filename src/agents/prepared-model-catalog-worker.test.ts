import { describe, expect, it, vi } from "vitest";
import { captureRuntimeConfig } from "../config/runtime-source-projection.js";
import * as cryptoDigest from "../infra/crypto-digest.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  createPreparedModelCatalogWorkerInput,
  fingerprintPreparedModelCatalogGeneration,
  fingerprintPreparedModelWorkerRequest,
} from "./prepared-model-catalog-worker.js";
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

  it("preserves captured auth identity and distinguishes source from built artifacts", () => {
    const authStore = {
      version: 1,
      profiles: {
        "shared:named": {
          type: "oauth" as const,
          provider: "shared",
          access: "access-token",
          refresh: "refresh-token",
          expires: 4_102_444_800_000,
          projectId: "project-id",
        },
        "unrelated:default": {
          type: "api_key" as const,
          provider: "unrelated",
          key: "materialized-key",
          keyRef: { source: "env" as const, provider: "default", id: "UNRELATED_KEY" },
        },
        "ref-api:default": {
          type: "api_key" as const,
          provider: "ref-api",
          keyRef: { source: "env" as const, provider: "default", id: "REF_API_KEY" },
        },
        "ref-token:default": {
          type: "token" as const,
          provider: "ref-token",
          tokenRef: { source: "env" as const, provider: "default", id: "REF_TOKEN" },
        },
      },
      order: { shared: ["shared:named"] },
      lastGood: { shared: "shared:named" },
    };
    const params = {
      agentFacts: {
        input: {
          agentDir: "/tmp/agent",
          config: {},
          workspaceDir: "/tmp/workspace",
          loadRuntimePlugins: true,
          runtimePluginSelections: [{ provider: "selected", modelId: "model" }],
        },
        env: {},
        authStore,
        credentials: { shared: { ...authStore.profiles["shared:named"] } },
        providerIds: ["configured"],
        configuredModelRefs: [],
        configuredRuntimeModels: [],
        runtimeCapabilityModels: [],
        configuredGeneratedCatalogPluginIds: [],
        templateAuthStorage: {} as never,
      } satisfies PreparedModelRuntimeAgentFacts,
      pluginMetadataSnapshot: {
        ...createPluginMetadataSnapshotFixture(),
        policyHash: "test-policy",
        configFingerprint: "test-config",
      },
    };
    const workerInput = createPreparedModelCatalogWorkerInput(params);

    const cloned = structuredClone(workerInput);
    expect(cloned.authStore.profiles).toEqual({
      "shared:named": authStore.profiles["shared:named"],
      "unrelated:default": {
        type: "api_key",
        provider: "unrelated",
        key: "materialized-key",
        keyRef: { source: "env", provider: "default", id: "UNRELATED_KEY" },
      },
      "ref-api:default": authStore.profiles["ref-api:default"],
      "ref-token:default": authStore.profiles["ref-token:default"],
    });
    expect(cloned.authStore.order).toEqual(authStore.order);
    expect(cloned.authStore.lastGood).toEqual(authStore.lastGood);
    expect(cloned.input.runtimePluginSelections).toEqual([
      { provider: "selected", modelId: "model" },
    ]);
    expect(cloned.input).not.toHaveProperty("inheritedAuthDir");
    expect(cloned.input).not.toHaveProperty("loadRuntimePlugins");
    const builtInput = structuredClone(
      createPreparedModelCatalogWorkerInput({ ...params, preferBuiltPluginArtifacts: true }),
    );
    expect(cloned.preferBuiltPluginArtifacts).toBe(false);
    expect(builtInput.preferBuiltPluginArtifacts).toBe(true);
    expect(builtInput.generationFingerprint).not.toBe(cloned.generationFingerprint);
    const request = {
      kind: "catalog" as const,
      syntheticAuth: [
        {
          providerRef: "native",
          result: { apiKey: "native-login-not-real", source: "fixture", mode: "oauth" as const },
        },
      ],
    };
    const fingerprint = fingerprintPreparedModelWorkerRequest(cloned, request);
    expect(fingerprintPreparedModelWorkerRequest(cloned, structuredClone(request))).toBe(
      fingerprint,
    );
    expect(
      fingerprintPreparedModelWorkerRequest(cloned, {
        ...request,
        syntheticAuth: [{ ...request.syntheticAuth[0]!, result: null }],
      }),
    ).not.toBe(fingerprint);
  });
});
