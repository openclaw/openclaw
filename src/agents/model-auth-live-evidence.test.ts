import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearCurrentPluginMetadataSnapshot,
  setCurrentPluginMetadataSnapshot,
} from "../plugins/current-plugin-metadata-snapshot.js";
import { resolveInstalledPluginIndexPolicyHash } from "../plugins/installed-plugin-index-policy.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { withEnvAsync } from "../test-utils/env.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import {
  hasAvailableAuthForProvider,
  resolveApiKeyForProvider,
  resolveLiveEnvApiKey,
} from "./model-auth.js";

const emptyStore: AuthProfileStore = {
  version: 1,
  profiles: {},
};

function createGoogleVertexAuthSnapshot(): PluginMetadataSnapshot {
  const policyHash = resolveInstalledPluginIndexPolicyHash({});
  const googlePlugin = {
    id: "google",
    origin: "bundled",
    providers: ["google-vertex"],
    providerAuthAliases: {},
    providerAuthChoices: [],
    setup: {
      providers: [
        {
          id: "google-vertex",
          authEvidence: [
            {
              type: "gce-metadata-token",
              requiresAnyEnv: ["GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT"],
              requiresAllEnv: ["GOOGLE_CLOUD_LOCATION"],
              credentialMarker: "gcp-vertex-credentials",
              source: "GCE metadata service account",
            },
          ],
        },
      ],
    },
  } as const;
  return {
    policyHash,
    index: {
      version: 1,
      hostContractVersion: "test",
      compatRegistryVersion: "test",
      migrationVersion: 1,
      policyHash,
      generatedAtMs: 1,
      installRecords: {},
      plugins: [],
      diagnostics: [],
    },
    registryDiagnostics: [],
    manifestRegistry: { plugins: [googlePlugin], diagnostics: [] },
    plugins: [googlePlugin],
    diagnostics: [],
    byPluginId: new Map([["google", googlePlugin]]),
    normalizePluginId: (pluginId) => pluginId,
    owners: {
      channels: new Map(),
      channelConfigs: new Map(),
      providers: new Map([["google-vertex", ["google"]]]),
      modelCatalogProviders: new Map(),
      cliBackends: new Map(),
      setupProviders: new Map([["google-vertex", ["google"]]]),
      commandAliases: new Map(),
      contracts: new Map(),
    },
    metrics: {
      registrySnapshotMs: 0,
      manifestRegistryMs: 0,
      ownerMapsMs: 0,
      totalMs: 0,
      indexPluginCount: 0,
      manifestPluginCount: 1,
    },
  } as PluginMetadataSnapshot;
}

describe("live provider auth evidence", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearCurrentPluginMetadataSnapshot();
  });

  it("resolves GCE metadata token evidence to a non-secret provider marker", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: " metadata-access-token " }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const resolved = await resolveLiveEnvApiKey(
      "google-vertex",
      {
        GOOGLE_CLOUD_PROJECT: "vertex-project",
        GOOGLE_CLOUD_LOCATION: "global",
      } as NodeJS.ProcessEnv,
      {
        authEvidenceMap: {
          "google-vertex": [
            {
              type: "gce-metadata-token",
              requiresAnyEnv: ["GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT"],
              requiresAllEnv: ["GOOGLE_CLOUD_LOCATION"],
              credentialMarker: "gcp-vertex-credentials",
              source: "GCE metadata service account",
            },
          ],
        },
        fetchImpl: fetchMock as unknown as typeof fetch,
      },
    );

    expect(resolved).toEqual({
      apiKey: "gcp-vertex-credentials",
      source: "GCE metadata service account",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      expect.objectContaining({
        headers: { "Metadata-Flavor": "Google" },
      }),
    );
  });

  it("ignores unavailable or malformed GCE metadata token evidence", async () => {
    const unavailableFetch = vi.fn().mockResolvedValue(new Response("not found", { status: 404 }));
    const malformedFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ token: "missing-access-token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const options = {
      authEvidenceMap: {
        "google-vertex": [
          {
            type: "gce-metadata-token" as const,
            credentialMarker: "gcp-vertex-credentials",
            source: "GCE metadata service account",
          },
        ],
      },
    };

    await expect(
      resolveLiveEnvApiKey("google-vertex", {} as NodeJS.ProcessEnv, {
        ...options,
        fetchImpl: unavailableFetch as unknown as typeof fetch,
      }),
    ).resolves.toBeNull();
    await expect(
      resolveLiveEnvApiKey("google-vertex", {} as NodeJS.ProcessEnv, {
        ...options,
        fetchImpl: malformedFetch as unknown as typeof fetch,
      }),
    ).resolves.toBeNull();
  });

  it("uses Google Vertex GCE metadata evidence for runtime auth availability", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-google-vertex-live-auth-"));
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify({ access_token: "metadata-vm-service-account-token" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

    try {
      await withEnvAsync(
        {
          GOOGLE_APPLICATION_CREDENTIALS: "",
          GOOGLE_CLOUD_PROJECT: "vertex-project",
          GOOGLE_CLOUD_LOCATION: "global",
          HOME: path.join(tempRoot, "home"),
          APPDATA: path.join(tempRoot, "appdata"),
        },
        async () => {
          setCurrentPluginMetadataSnapshot(createGoogleVertexAuthSnapshot(), { config: {} });
          await expect(
            hasAvailableAuthForProvider({
              provider: "google-vertex",
              cfg: {},
              store: emptyStore,
            }),
          ).resolves.toBe(true);
          await expect(
            resolveApiKeyForProvider({
              provider: "google-vertex",
              cfg: {},
              store: emptyStore,
            }),
          ).resolves.toMatchObject({
            apiKey: "gcp-vertex-credentials",
            source: "GCE metadata service account",
            mode: "api-key",
          });
        },
      );
    } finally {
      fetchSpy.mockRestore();
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
