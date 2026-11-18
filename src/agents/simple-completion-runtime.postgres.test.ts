import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import path from "node:path";
import { threadId } from "node:worker_threads";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { captureRuntimeConfigAsyncReader } from "../config/io.runtime.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { publishSystemEventStoreConfig } from "../config/sessions/session-store-path.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as databaseAdmission from "../infra/database-engine/admission-scope.js";
import {
  mixedAgentConnection,
  mixedAgentPairs,
  useMixedAgentPair,
} from "../infra/database-engine/mixed-agent.conformance.test-support.js";
import { setGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { clearCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { resolvePluginMetadataSnapshotAsync } from "../plugins/plugin-metadata-snapshot.js";
import {
  createColdPluginFixture,
  isColdPluginRuntimeLoaded,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";
import {
  acquireSimpleCompletionModelForAgent,
  completeWithPreparedSimpleCompletionModel,
} from "./simple-completion-runtime.js";
import {
  assertPrepared,
  completionChunk,
  completionContext,
  completionModelDefinition,
  startCompletionServer,
} from "./simple-completion.test-support.js";

// A test Worker would bypass the Gateway main-thread database restriction.
expect(threadId).toBe(0);
databaseAdmission.installDatabaseProcessRole("gateway");
const assertEngineStoreExecutionAllowed = databaseAdmission.assertEngineStoreExecutionAllowed;

describe.skipIf(!mixedAgentConnection)("Gateway simple completion acquisition", () => {
  for (const { stateEngine, agentEngine } of mixedAgentPairs.filter(
    (pair) => pair.stateEngine === "postgres" || pair.agentEngine === "postgres",
  )) {
    describe(`${stateEngine} state / ${agentEngine} agent`, () => {
      const fixture = useMixedAgentPair(stateEngine, agentEngine);

      it("acquires from startup metadata, completes and releases without host PostgreSQL", async () => {
        onTestFinished(async () => {
          await resetPreparedModelRuntimeSnapshotsForTest();
          clearCurrentPluginMetadataSnapshot();
          clearPluginMetadataLifecycleCaches();
          resetPluginLoaderTestStateForTest();
        });
        const workspaceDir = path.join(fixture.root, "workspace");
        const selectedRoot = path.join(fixture.root, "selected");
        const unrelatedRoot = path.join(fixture.root, "unrelated");
        const bundledRoot = path.join(fixture.root, "bundled");
        for (const directory of [workspaceDir, selectedRoot, unrelatedRoot, bundledRoot]) {
          fs.mkdirSync(directory);
        }
        vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledRoot);
        vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
        const selected = createColdPluginFixture({
          rootDir: selectedRoot,
          pluginId: "completion-selected",
          providerId: "completion-provider",
        });
        const unrelated = createColdPluginFixture({
          rootDir: unrelatedRoot,
          pluginId: "completion-unrelated",
          providerId: "unrelated-provider",
        });
        fs.writeFileSync(
          selected.runtimeSource,
          `require("node:fs").writeFileSync(${JSON.stringify(selected.runtimeMarker)}, "loaded");
module.exports = {
  id: ${JSON.stringify(selected.pluginId)},
  register(api) {
    api.registerProvider({ id: ${JSON.stringify(selected.providerId)}, label: "Completion", auth: [] });
  },
};
`,
        );
        const authorizations: Array<string | undefined> = [];
        await using server = await startCompletionServer((request, response) => {
          request.resume();
          authorizations.push(request.headers.authorization);
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(completionChunk("completed", "completion-model"));
        });
        const config = {
          ...(await captureRuntimeConfigAsyncReader()()),
          agents: {
            defaults: { workspace: workspaceDir, model: "completion-provider/completion-model" },
          },
          models: {
            providers: {
              "completion-provider": {
                api: "openai-completions" as const,
                baseUrl: server.baseUrl,
                apiKey: "fixture-completion-key",
                models: [completionModelDefinition({ id: "completion-model" })],
              },
            },
          },
          plugins: {
            load: { paths: [selectedRoot, unrelatedRoot] },
            slots: { memory: "none" },
            entries: {
              [selected.pluginId]: { enabled: true },
              [unrelated.pluginId]: { enabled: true },
            },
          },
        } satisfies OpenClawConfig;
        setRuntimeConfigSnapshot(config);
        publishSystemEventStoreConfig(config);
        // Gateway startup publishes the complete inventory before the first acquisition.
        const metadata = await resolvePluginMetadataSnapshotAsync({
          config,
          env: process.env,
          workspaceDir,
          allowCurrent: false,
        });
        expect(metadata.plugins.map((plugin) => plugin.id)).toEqual(
          expect.arrayContaining([selected.pluginId, unrelated.pluginId]),
        );
        setGatewayPluginMetadataSnapshot(metadata, { config, env: process.env, workspaceDir });
        expect(isColdPluginRuntimeLoaded(selected)).toBe(false);
        expect(isColdPluginRuntimeLoaded(unrelated)).toBe(false);
        expect(() => assertEngineStoreExecutionAllowed()).toThrow(
          "PostgreSQL connections must run in a worker",
        );
        const deniedCalls: string[] = [];
        using _guard = vi
          .spyOn(databaseAdmission, "assertEngineStoreExecutionAllowed")
          .mockImplementation(() => {
            try {
              assertEngineStoreExecutionAllowed();
            } catch (error) {
              deniedCalls.push(String(error));
              throw error;
            }
          });
        const statements = channel("openclaw.database.statement");
        const hostStatements: unknown[] = [];
        const observe = (message: unknown) => {
          if ((message as { engine?: string }).engine === "postgres") {
            hostStatements.push(message);
          }
        };
        statements.subscribe(observe);
        try {
          const acquired = await acquireSimpleCompletionModelForAgent({
            cfg: config,
            agentId: "main",
          });
          assertPrepared(acquired);
          try {
            expect(acquired.selection).toMatchObject({
              provider: selected.providerId,
              modelId: "completion-model",
            });
            expect(isColdPluginRuntimeLoaded(selected)).toBe(true);
            expect(isColdPluginRuntimeLoaded(unrelated)).toBe(false);
            const complete = () =>
              completeWithPreparedSimpleCompletionModel({
                model: acquired.model,
                auth: acquired.auth,
                cfg: config,
                context: completionContext(),
              });
            await expect(complete()).resolves.toMatchObject({
              stopReason: "stop",
              content: [{ type: "text", text: "completed" }],
            });
            await acquired[Symbol.asyncDispose]();
            await expect(complete()).rejects.toThrow("Prepared completion model has been released");
            expect(authorizations).toEqual(["Bearer fixture-completion-key"]);
            expect(deniedCalls).toEqual([]);
            expect(hostStatements).toEqual([]);
          } finally {
            await acquired[Symbol.asyncDispose]();
          }
        } finally {
          statements.unsubscribe(observe);
        }
      });
    });
  }
});
