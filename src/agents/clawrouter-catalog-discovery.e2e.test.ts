import fs from "node:fs";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { captureClawInstallSchemaVersionFacts } from "../claws/provenance-runtime-read.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  buildModelsListResult,
  createGatewayAgentModelCatalogProjector,
} from "../gateway/server-methods/models-list-result.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { WorkerTaskPool } from "../infra/worker-task-pool.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
} from "./auth-profiles/credential-fixtures.test-support.js";
import {
  createPreparedModelCatalogWorkerInput,
  type PreparedModelCatalogWorkerTask,
  type PreparedModelWorkerResult,
} from "./prepared-model-catalog-worker.js";
import { prepareWorkspaceBuildGroup } from "./prepared-model-runtime.facts.js";

describe("ClawRouter cold prepared catalog", () => {
  let state: OpenClawTestState;
  let server: Awaited<ReturnType<typeof reserveTestPortListener<Server>>> | undefined;
  let pool: WorkerTaskPool<PreparedModelCatalogWorkerTask, PreparedModelWorkerResult> | undefined;

  afterEach(async () => {
    await pool?.close();
    pool = undefined;
    if (server) {
      server.listener.closeAllConnections();
      await server.releaseListener();
      await server.claim.release();
      server = undefined;
    }
    await state.cleanup();
  });

  it.each([
    {
      label: "publishes metadata with a sibling catalog=false",
      sibling: false,
      refreshedAuth: false,
    },
    {
      label: "publishes metadata with a sibling catalog=true",
      sibling: true,
      refreshedAuth: false,
    },
    {
      label: "discovers a provider introduced by refreshed auth",
      sibling: true,
      refreshedAuth: true,
    },
  ])("$label", async ({ sibling, refreshedAuth }) => {
    state = await createOpenClawTestState({
      label: "clawrouter-catalog",
      env: {
        CLAWROUTER_API_KEY: refreshedAuth ? undefined : "catalog-test-key",
        OPENAI_API_KEY: undefined,
        CODEX_API_KEY: undefined,
        CODEX_HOME: undefined,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      },
    });
    const requests: Array<{ url: string | undefined; authorization: string | undefined }> = [];
    server = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((request, response) => {
          requests.push({ url: request.url, authorization: request.headers.authorization });
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({
              providers: [
                {
                  id: "private",
                  displayName: "Synthetic provider",
                  openaiCompatible: true,
                  nativeBaseUrl: "/v1/native/private",
                  models: [
                    {
                      id: "codex-latest",
                      displayName: "Codex (Latest)",
                      upstream: "codex-latest",
                      capabilities: ["llm.responses"],
                      supportedReasoningEfforts: ["low", "high"],
                    },
                  ],
                },
              ],
            }),
          );
        }),
    });
    const baseUrl = `http://127.0.0.1:${server.claim.port}/private`;
    const agentId = "private-openclaw";
    const config: OpenClawConfig = {
      plugins: {
        slots: { memory: "none" },
        allow: sibling ? ["clawrouter", "openai"] : ["clawrouter"],
        entries: {
          clawrouter: { enabled: true },
          ...(sibling ? { openai: { enabled: true } } : {}),
        },
      },
      models: {
        providers: {
          clawrouter: {
            baseUrl,
            ...(refreshedAuth
              ? {}
              : {
                  apiKey: {
                    source: "env" as const,
                    provider: "default",
                    id: "CLAWROUTER_API_KEY",
                  },
                }),
            agentRuntime: { id: "openclaw" },
            models: [],
          },
        },
      },
      agents: {
        defaults: {
          workspace: state.workspaceDir,
          model: { primary: sibling ? "openai/codex-latest" : "clawrouter/codex-latest" },
          models: {
            ...(refreshedAuth
              ? {}
              : { "clawrouter/codex-latest": { agentRuntime: { id: "openclaw" } } }),
            ...(sibling ? { "openai/codex-latest": { agentRuntime: { id: "openclaw" } } } : {}),
          },
          modelPolicy: { allow: ["clawrouter/codex-latest"] },
        },
        list: [
          {
            id: agentId,
            model: { primary: refreshedAuth ? "openai/codex-latest" : "clawrouter/codex-latest" },
          },
        ],
      },
    };
    const input = {
      agentId,
      agentDir: state.agentDir(agentId),
      workspaceDir: state.workspaceDir,
      config,
      env: state.env,
      skipCredentials: true,
    };
    // The E2E owner builds the real plugin artifacts before the catalog deadline starts.
    const prepared = await prepareWorkspaceBuildGroup([input], "static", {
      preferBuiltPluginArtifacts: true,
    });
    const value = createPreparedModelCatalogWorkerInput({
      agentFacts: prepared.agentFacts[0]!,
      pluginMetadataSnapshot: prepared.pluginGeneration.pluginMetadataSnapshot,
    });
    if (refreshedAuth) {
      // The new credential must enter through the worker's durable auth refresh,
      // without a configured model preloading its provider into the startup scope.
      expect(value.providerIds).not.toContain("clawrouter");
      await state.writeAuthProfiles(
        createAuthProfileStoreFixture({
          "clawrouter:default": createApiKeyCredential("clawrouter", "catalog-test-key"),
        }),
        agentId,
      );
    }
    const sourceCaptureDirectory = state.path("worker-captures");
    fs.mkdirSync(sourceCaptureDirectory);
    pool = new WorkerTaskPool<PreparedModelCatalogWorkerTask, PreparedModelWorkerResult>({
      workerUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.preparedModelCatalog),
      maxWorkers: 1,
      idleTimeoutMs: 0,
      restartOnError: false,
      workerOptions: { env: state.env, workerData: { sourceCaptureDirectory } },
    });
    const result = await pool.run(
      {
        value,
        request: {
          kind: "catalog",
          syntheticAuth: [],
          clawInstallSchemaVersions: captureClawInstallSchemaVersionFacts({ env: state.env }),
        },
      },
      { timeoutMs: 30_000 },
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.kind !== "catalog") {
      throw new Error("catalog worker did not publish a catalog");
    }
    expect(result.runtimeModels.get("clawrouter")).toContainEqual(
      expect.objectContaining({
        provider: "clawrouter",
        id: "codex-latest",
        api: "openai-responses",
        baseUrl: `${baseUrl}/v1`,
      }),
    );
    const projector = createGatewayAgentModelCatalogProjector({
      cfg: config,
      agentId,
      snapshot: result.snapshot,
      metadataSnapshot: prepared.pluginGeneration.pluginMetadataSnapshot,
      preparedAuthStore: result.authStore,
      preparedRuntimeAuthModes: result.authModes,
    });
    const catalog = await buildModelsListResult({
      source: {
        kind: "gateway",
        context: { getRuntimeConfig: () => config } as GatewayRequestContext,
      },
      agentId,
      params: { view: refreshedAuth ? "all" : "configured", preparedOnly: true },
      preloadedCatalog: { agentId, config, snapshot: result.snapshot },
      preloadedOnly: true,
      catalogProjector: projector,
    });
    expect(catalog.models).toContainEqual(
      expect.objectContaining({
        provider: "clawrouter",
        id: "codex-latest",
        name: "Codex (Latest)",
        reasoning: true,
        available: true,
      }),
    );
    expect(requests).toEqual([
      { url: "/private/v1/catalog", authorization: "Bearer catalog-test-key" },
    ]);
  });
});
