// Exec reviewer tests cover command review started from a retired plugin generation.
import fs from "node:fs";
import { createServer } from "node:http";
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
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import {
  createColdPluginFixture,
  createColdPluginHermeticEnv,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { createSyncSuiteTempRootTracker } from "../plugins/test-helpers/fs-fixtures.js";
import { withEnvAsync } from "../test-utils/env.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./auth-profiles/runtime-snapshots.js";
import { createModelExecAutoReviewer } from "./exec-auto-reviewer.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";

// The reviewed command is input data only; this fixture never dispatches it.
const input = {
  command: "git status",
  host: "gateway" as const,
  reason: "approval-required" as const,
  analysis: { parsed: true, allowlistMatched: false, inlineEval: false },
};

it("admits the successor plugin inventory for a review started in a retired scope", async () => {
  const roots = createSyncSuiteTempRootTracker("exec-reviewer-retired-inventory");
  const root = fs.realpathSync(roots.makeTempDir());
  const workspaceDir = path.join(root, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
  const providerRoot = path.join(root, "provider");
  fs.mkdirSync(providerRoot);
  const fixture = createColdPluginFixture({
    rootDir: providerRoot,
    pluginId: "reviewer-fixture",
    providerId: "reviewer-provider",
  });
  fs.writeFileSync(
    fixture.runtimeSource,
    `module.exports = { id: "reviewer-fixture", register(api) { api.registerProvider({ id: "reviewer-provider", label: "Reviewer fixture", auth: [] }); } };`,
  );
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({ id: "review", object: "chat.completion.chunk", model: "reviewer", choices: [{ index: 0, delta: { content: JSON.stringify({ decision: "ask", risk: "low", rationale: "fixture" }) }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fixture server has no TCP port");
  }
  const cfg: OpenClawConfig = {
    agents: { defaults: { workspace: workspaceDir, model: `${fixture.providerId}/reviewer` } },
    models: {
      providers: {
        [fixture.providerId]: {
          api: "openai-completions",
          apiKey: "fixture-only",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          models: [
            {
              id: "reviewer",
              name: "Reviewer",
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
          const foregroundCache = createPluginCache();
          const foregroundMetadata = withPluginCache(foregroundCache, () =>
            resolvePluginMetadataSnapshot({ config: cfg, workspaceDir }),
          );
          setGatewayPluginMetadataSnapshot(foregroundMetadata, { config: cfg, workspaceDir });

          // A plugin operation publishes the successor generation and retires the foreground cache.
          const successorCache = createPluginCache();
          const successorMetadata = withPluginCache(successorCache, () =>
            resolvePluginMetadataSnapshot({ config: cfg, workspaceDir }),
          );
          setGatewayPluginMetadataSnapshot(successorMetadata, { config: cfg, workspaceDir });
          retirement = retirePluginCache(foregroundCache);
          expect(() => retainPluginCache(foregroundCache)).toThrow("Plugin inventory has retired");
          expect(getPluginMetadataSnapshotCache(successorMetadata)).not.toBe(foregroundCache);

          const reviewer = createModelExecAutoReviewer({
            cfg,
            agentId: "main",
            reviewer: { timeoutMs: 5000 },
          });
          // The turn keeps running in its own generation scope after the plugin operation.
          const decision = await withPluginRuntimeGenerationScope(
            { metadataSnapshot: foregroundMetadata },
            () => reviewer(input),
          );
          expect(decision).toMatchObject({
            decision: "ask",
            risk: "low",
            rationale: "fixture",
          });
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
