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
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { resolveAgentDir } from "./agent-scope.js";
import { resolveSharedAuthStoreOwnership } from "./auth-profiles/path-resolve.js";
import { upsertAuthProfileAsync } from "./auth-profiles/profiles.js";
import {
  loadPersistedAuthProfileStoreFromRows,
  prepareAgentAuthProfileRowsRead,
  readAuthProfileSources,
} from "./auth-profiles/sqlite-read.js";
import { resolveAuthProfileDatabasePath } from "./auth-profiles/sqlite.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";
import { completeWithAuthProfileFailover } from "./simple-completion-profile-failover.js";
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

async function readPersistedHealth(agentId: string, agentDir: string) {
  const localPath = resolveAuthProfileDatabasePath(agentDir);
  const reader = await prepareAgentAuthProfileRowsRead({
    databasePath: localPath,
    agentId,
    env: process.env,
  });
  try {
    const context = captureOpenClawStateWorkerContext();
    const sharedPath = context.admission.databasePath;
    // Read both authoritative owners afresh; acquisition's store and row cache are not proof of a commit.
    const rows = await readAuthProfileSources(
      context,
      [{ kind: "shared-state", databasePath: sharedPath }, reader.source],
      { assertCurrent: reader.assertCurrent },
    );
    expect(rows?.has(sharedPath)).toBe(true);
    expect(rows?.has(localPath)).toBe(true);
    const shared = loadPersistedAuthProfileStoreFromRows(rows!.get(sharedPath)!, sharedPath);
    const local = loadPersistedAuthProfileStoreFromRows(rows!.get(localPath)!, localPath);
    if (!shared || !local) {
      throw new Error("Expected persisted auth profiles for both database owners");
    }
    return { shared, local };
  } finally {
    await reader.dispose();
  }
}

describe.skipIf(!mixedAgentConnection)("Gateway simple completion acquisition", () => {
  for (const { stateEngine, agentEngine } of mixedAgentPairs.filter(
    (pair) => pair.stateEngine === "postgres" || pair.agentEngine === "postgres",
  )) {
    describe(`${stateEngine} state / ${agentEngine} agent`, () => {
      const fixture = useMixedAgentPair(stateEngine, agentEngine);

      const scenarios = ["configured", "failover"];
      if (stateEngine === "postgres" && agentEngine === "postgres") {
        scenarios.push("pinned");
      }
      it.each(scenarios)(
        "%s: acquires, completes and releases without host PostgreSQL",
        async (scenario) => {
          onTestFinished(async () => {
            await resetPreparedModelRuntimeSnapshotsForTest();
            clearCurrentPluginMetadataSnapshot();
            clearPluginMetadataLifecycleCaches();
            resetPluginLoaderTestStateForTest();
          });
          const root = fs.mkdtempSync(path.join(fixture.root, "completion-"));
          const workspaceDir = path.join(root, "workspace");
          const selectedRoot = path.join(root, "selected");
          const unrelatedRoot = path.join(root, "unrelated");
          const bundledRoot = path.join(root, "bundled");
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
          const storedProfiles = scenario !== "configured";
          const primaryId = `completion-provider:${scenario}:primary`;
          const backupId = `completion-provider:${scenario}:backup`;
          const agentId = storedProfiles ? `completion-${scenario}` : "main";
          const authorizations: Array<string | undefined> = [];
          await using server = await startCompletionServer((request, response) => {
            request.resume();
            authorizations.push(request.headers.authorization);
            if (request.headers.authorization === "Bearer fixture-primary-key") {
              response.writeHead(429, {
                "content-type": "application/json",
                "retry-after": "60",
              });
              response.end(
                JSON.stringify({
                  error: { message: "Rate limit exceeded", code: "rate_limit_exceeded" },
                }),
              );
              return;
            }
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.end(completionChunk("completed", "completion-model"));
          });
          const config = {
            ...(await captureRuntimeConfigAsyncReader()()),
            agents: {
              ownership: "explicit",
              entries: { main: {}, [agentId]: {} },
              defaults: { workspace: workspaceDir, model: "completion-provider/completion-model" },
            },
            auth: { order: { "completion-provider": [primaryId, backupId] } },
            models: {
              providers: {
                "completion-provider": {
                  api: "openai-completions" as const,
                  baseUrl: server.baseUrl,
                  ...(!storedProfiles ? { apiKey: "fixture-completion-key" } : {}),
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
          using guard = vi
            .spyOn(databaseAdmission, "assertEngineStoreExecutionAllowed")
            .mockImplementation(assertEngineStoreExecutionAllowed);
          const statements = channel("openclaw.database.statement");
          const hostStatements: unknown[] = [];
          const observe = (message: unknown) => {
            if ((message as { engine?: string }).engine === "postgres") {
              hostStatements.push(message);
            }
          };
          statements.subscribe(observe);
          try {
            const agentDir = resolveAgentDir(config, agentId);
            if (storedProfiles) {
              // Fail shared/state credentials, then succeed with the agent's own credential.
              await upsertAuthProfileAsync({
                profileId: primaryId,
                credential: {
                  type: "api_key",
                  provider: selected.providerId,
                  key: "fixture-primary-key",
                },
              });
              expect(resolveSharedAuthStoreOwnership(process.env).location).toBe("state-db");
              await upsertAuthProfileAsync({
                agentDir,
                profileId: backupId,
                credential: {
                  type: "api_key",
                  provider: selected.providerId,
                  key: "fixture-backup-key",
                },
              });
            }
            const acquired = await acquireSimpleCompletionModelForAgent({
              cfg: config,
              agentId,
              ...(storedProfiles ? { profileFailover: true, preferredProfile: primaryId } : {}),
              ...(scenario === "pinned"
                ? {
                    modelRef: `completion-provider/completion-model@${primaryId}`,
                    bindAuthOwner: true,
                  }
                : {}),
            });
            assertPrepared(acquired);
            try {
              expect(acquired.selection).toMatchObject({
                provider: selected.providerId,
                modelId: "completion-model",
              });
              expect(isColdPluginRuntimeLoaded(selected)).toBe(true);
              expect(isColdPluginRuntimeLoaded(unrelated)).toBe(false);
              const complete = (current: Pick<typeof acquired, "model" | "auth"> = acquired) =>
                completeWithPreparedSimpleCompletionModel({
                  model: current.model,
                  auth: current.auth,
                  cfg: config,
                  context: completionContext(),
                });
              if (storedProfiles) {
                expect(acquired.auth.profileId).toBe(primaryId);
                expect(acquired.authProfiles?.profileIds).toEqual(
                  scenario === "pinned" ? [primaryId] : [primaryId, backupId],
                );
                const warnings: string[] = [];
                const started = Date.now();
                const result = await completeWithAuthProfileFailover({
                  prepared: acquired,
                  cfg: config,
                  agentDir,
                  assertCurrent: () => {},
                  complete,
                  warn: (message) => warnings.push(message),
                });
                expect(warnings).toEqual([]);
                expect(result).toMatchObject(
                  scenario === "pinned"
                    ? { stopReason: "error", content: [] }
                    : { stopReason: "stop", content: [{ type: "text", text: "completed" }] },
                );
                expect(authorizations).toEqual(
                  scenario === "pinned"
                    ? ["Bearer fixture-primary-key"]
                    : ["Bearer fixture-primary-key", "Bearer fixture-backup-key"],
                );
                const { shared, local } = await readPersistedHealth(agentId, agentDir);
                const failed = shared.usageStats?.[primaryId];
                expect(failed?.lastRateLimitAt).toBeGreaterThanOrEqual(started);
                expect(failed).toMatchObject({
                  cooldownReason: "rate_limit",
                  cooldownModel: "completion-model",
                });
                expect(failed?.cooldownUntil).toBeGreaterThanOrEqual(started + 60_000);
                expect(failed?.errorCount).toBeUndefined();
                expect(failed?.failureCounts).toBeUndefined();
                expect(shared.profiles[backupId]).toBeUndefined();
                expect(shared.usageStats?.[backupId]).toBeUndefined();
                expect(local.profiles[primaryId]).toBeUndefined();
                expect(local.usageStats?.[primaryId]).toBeUndefined();
                if (scenario === "pinned") {
                  expect(local.usageStats?.[backupId]).toBeUndefined();
                  expect(local.lastGood?.[selected.providerId]).toBeUndefined();
                } else {
                  const success = local.usageStats?.[backupId];
                  expect(success?.lastUsed).toBeGreaterThanOrEqual(started);
                  expect(success?.lastProbeAt).toBeGreaterThanOrEqual(started);
                  expect(success?.errorCount).toBe(0);
                  expect(local.lastGood?.[selected.providerId]).toBe(backupId);
                }
              } else {
                await expect(complete()).resolves.toMatchObject({
                  stopReason: "stop",
                  content: [{ type: "text", text: "completed" }],
                });
                expect(authorizations).toEqual(["Bearer fixture-completion-key"]);
              }
              await acquired[Symbol.asyncDispose]();
              await expect(complete()).rejects.toThrow(
                "Prepared completion model has been released",
              );
              expect(guard.mock.results.filter(({ type }) => type === "throw")).toEqual([]);
              expect(hostStatements).toEqual([]);
            } finally {
              await acquired[Symbol.asyncDispose]();
            }
          } finally {
            statements.unsubscribe(observe);
          }
        },
      );
    });
  }
});
