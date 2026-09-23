// Direct plugin completions must be admitted against the committed inventory when the
// caller still runs in a retained, already retired plugin generation.
import fs from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import {
  createPluginCache,
  getPluginMetadataSnapshotCache,
  retainPluginCache,
  retirePluginCache,
  withPluginCache,
} from "../plugins/plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import {
  runOutsidePluginRuntimeGenerationScope,
  withPluginRuntimeGenerationScope,
} from "../plugins/runtime/generation-scope.js";
import {
  createColdPluginFixture,
  createColdPluginHermeticEnv,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { createSyncSuiteTempRootTracker } from "../plugins/test-helpers/fs-fixtures.js";
import { withEnvAsync } from "../test-utils/env.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./auth-profiles/runtime-snapshots.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";
import {
  acquireSimpleCompletionModelForAgent,
  completeWithPreparedSimpleCompletionModel,
} from "./simple-completion-runtime.js";

const PROOF_COMPLETION_TEXT = "retired-generation-completion-9F3E2D";

it("admits a direct completion against the committed inventory from a retired generation", async () => {
  const roots = createSyncSuiteTempRootTracker("completion-retired-inventory");
  const root = fs.realpathSync(roots.makeTempDir());
  const workspaceDir = path.join(root, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
  const providerRoot = path.join(root, "provider");
  fs.mkdirSync(providerRoot);
  const fixture = createColdPluginFixture({
    rootDir: providerRoot,
    pluginId: "completion-fixture",
    providerId: "completion-fixture-provider",
  });
  fs.writeFileSync(
    fixture.runtimeSource,
    `module.exports = { id: ${JSON.stringify(fixture.pluginId)}, register(api) { api.registerProvider({ id: ${JSON.stringify(fixture.providerId)}, label: "Completion fixture", auth: [] }); } };`,
  );
  const requests: string[] = [];
  const server = createServer((request, response: ServerResponse) => {
    request.resume();
    requests.push(request.url ?? "/");
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({
        id: "completion-fixture-response",
        object: "chat.completion.chunk",
        model: "completion-fixture-model",
        choices: [
          {
            index: 0,
            delta: { content: PROOF_COMPLETION_TEXT },
            finish_reason: "stop",
          },
        ],
      })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Completion fixture has no TCP port");
  }
  const cfg: OpenClawConfig = {
    agents: {
      defaults: {
        workspace: workspaceDir,
        model: `${fixture.providerId}/completion-fixture-model`,
      },
    },
    models: {
      providers: {
        [fixture.providerId]: {
          api: "openai-completions",
          apiKey: "fixture-only",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          models: [
            {
              id: "completion-fixture-model",
              name: "Completion fixture",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 8192,
              maxTokens: 1024,
            },
          ],
        },
      },
    },
    plugins: {
      load: { paths: [fixture.rootDir] },
      slots: { memory: "none" },
      entries: { [fixture.pluginId]: { enabled: true } },
    },
  };
  try {
    await withEnvAsync(
      {
        ...createColdPluginHermeticEnv(root, { bundledPluginsDir: roots.makeTempDir() }),
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_STATE_DIR: path.join(root, "state"),
      },
      async () => {
        let retirement: ReturnType<typeof retirePluginCache> | undefined;
        try {
          const retainedCache = createPluginCache();
          const retainedMetadata = withPluginCache(retainedCache, () =>
            resolvePluginMetadataSnapshot({ config: cfg, workspaceDir }),
          );
          setGatewayPluginMetadataSnapshot(retainedMetadata, { config: cfg, workspaceDir });

          // A plugin operation publishes the successor generation and retires the retained cache.
          const successorCache = createPluginCache();
          const successorMetadata = withPluginCache(successorCache, () =>
            resolvePluginMetadataSnapshot({ config: cfg, workspaceDir }),
          );
          setGatewayPluginMetadataSnapshot(successorMetadata, { config: cfg, workspaceDir });
          retirement = retirePluginCache(retainedCache);
          expect(() => retainPluginCache(retainedCache)).toThrow("Plugin inventory has retired");
          expect(getPluginMetadataSnapshotCache(successorMetadata)).not.toBe(retainedCache);

          const completeOnce = async (): Promise<unknown> => {
            const acquired = await acquireSimpleCompletionModelForAgent({
              cfg,
              agentId: "main",
              modelRef: `${fixture.providerId}/completion-fixture-model`,
              signal: AbortSignal.timeout(15_000),
            });
            if ("error" in acquired) {
              throw new Error(acquired.error);
            }
            await using prepared = acquired;
            return await completeWithPreparedSimpleCompletionModel({
              model: prepared.model,
              auth: prepared.auth,
              cfg,
              context: { messages: [{ role: "user", content: "Complete", timestamp: 1 }] },
            });
          };

          // Control: fresh host-owned admission selects the committed inventory.
          await expect(
            runOutsidePluginRuntimeGenerationScope(() => completeOnce()),
          ).resolves.toMatchObject({
            stopReason: "stop",
            content: [{ type: "text", text: PROOF_COMPLETION_TEXT }],
          });
          const controlRequests = requests.length;
          expect(controlRequests).toBeGreaterThan(0);

          // The retained generation keeps serving its own callbacks after retirement.
          await expect(
            withPluginRuntimeGenerationScope({ metadataSnapshot: retainedMetadata }, () =>
              completeOnce(),
            ),
          ).resolves.toMatchObject({
            stopReason: "stop",
            content: [{ type: "text", text: PROOF_COMPLETION_TEXT }],
          });
          expect(requests.length).toBe(controlRequests + 1);
        } finally {
          await retirement?.catch(() => {});
          await resetPreparedModelRuntimeSnapshotsForTest();
          clearRuntimeAuthProfileStoreSnapshots();
          clearPluginMetadataLifecycleCaches();
          resetPluginLoaderTestStateForTest();
        }
      },
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    roots.cleanup();
  }
});
