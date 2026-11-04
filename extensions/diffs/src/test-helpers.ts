import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import type {
  OpenBlobStoreOptions,
  PluginBlobStoreWithReceipts,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginBlobStoreForTests,
  createPluginBlobKernelStore,
  resetPluginBlobStoreForTests,
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  openOpenClawStateDatabase,
  type OpenClawStateKyselyDatabaseForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { vi } from "vitest";
import { registerDiffsPlugin } from "./plugin.js";
import { DiffArtifactStore } from "./store.js";
import type { DiffArtifactBlobMetadata } from "./types.js";

const execFileAsync = promisify(execFile);
export const diffContext = {
  agentId: "main",
  sessionId: "session-123",
  messageChannel: "discord",
  agentAccountId: "default",
};

export function registerDiffsForTest(params: {
  stateDir: string;
  config?: OpenClawConfig;
  getConfig?: () => OpenClawConfig;
  blobStore?: PluginBlobStoreWithReceipts<DiffArtifactBlobMetadata>;
}) {
  const getConfig = params.getConfig ?? (() => params.config ?? {});
  const registerTool = vi.fn<OpenClawPluginApi["registerTool"]>();
  const registerHttpRoute = vi.fn<OpenClawPluginApi["registerHttpRoute"]>();
  const registerService = vi.fn<OpenClawPluginApi["registerService"]>();
  const runtime = createPluginRuntimeMock({ config: { current: getConfig } });
  runtime.state.openBlobStore = params.blobStore
    ? vi.fn().mockReturnValue(params.blobStore)
    : <TMetadata>(options: OpenBlobStoreOptions) =>
        createPluginBlobStoreForTests<TMetadata>("diffs", options, {
          ...process.env,
          OPENCLAW_STATE_DIR: params.stateDir,
        });
  const api = createTestPluginApi({
    config: getConfig(),
    runtime,
    registerTool,
    registerHttpRoute,
    registerService,
  });
  registerDiffsPlugin(api);
  const factory = registerTool.mock.calls[0]?.[0];
  assert.ok(typeof factory === "function", "Diffs must register its tool factory");
  const handler = registerHttpRoute.mock.calls.find(
    ([route]) => route.path === "/plugins/diffs",
  )?.[0].handler;
  assert.ok(handler, "Diffs must register its viewer route");
  const service = registerService.mock.calls[0]?.[0];
  assert.ok(service && service.apiVersion !== 2, "Diffs must register its cleanup service");
  return {
    handler,
    tool(context: OpenClawPluginToolContext = {}) {
      const tool = factory(context);
      assert.ok(tool && !Array.isArray(tool), "Diffs must return one tool");
      return tool;
    },
    stop: async () =>
      service.stop?.({ config: getConfig(), stateDir: params.stateDir, logger: api.logger }),
  };
}

export function registerDiffsHttpRouteForTest(params: {
  stateDir: string;
  config?: OpenClawConfig;
}) {
  return registerDiffsForTest(params).handler;
}

export async function expireDiffArtifactForTest(
  rootDir: string,
  id: string,
  expectedTtlMs: number,
): Promise<void> {
  const { db } = openOpenClawStateDatabase({
    env: { ...process.env, OPENCLAW_STATE_DIR: path.join(path.dirname(rootDir), "state") },
  });
  const database = getNodeSqliteKysely<OpenClawStateKyselyDatabaseForTests>(db);
  const identity = { plugin_id: "diffs", namespace: "diff-artifacts", entry_key: id };
  const entry = executeSqliteQuerySync(
    db,
    database
      .selectFrom("plugin_blob_entries")
      .select(["created_at", "expires_at"])
      .where((eb) => eb.and(identity)),
  ).rows[0];
  assert.ok(entry);
  assert.ok(entry.expires_at !== null);
  assert.equal(entry.expires_at - entry.created_at, expectedTtlMs);
  const result = executeSqliteQuerySync(
    db,
    database
      .updateTable("plugin_blob_entries")
      .set({ expires_at: 1 })
      .where((eb) => eb.and(identity)),
  );
  assert.equal(Number(result.numAffectedRows), 1);
}

export async function ensureCuratedViewerRuntimeForTests(): Promise<void> {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const runtimePath = path.join(repoRoot, "extensions", "diffs", "assets", "viewer-runtime.js");
  const runtime = await fs.stat(runtimePath).catch((error: unknown) => {
    if (extractErrorCode(error) !== "ENOENT") {
      throw error;
    }
    return undefined;
  });
  if (runtime) {
    return;
  }

  // The curated runtime is generated output. Source tests that serve viewer
  // assets need a clean-checkout fixture before the normal build hook runs.
  await execFileAsync(
    process.execPath,
    ["--import", "tsx", "scripts/build-diffs-viewer-runtime.mts", "curated"],
    { cwd: repoRoot },
  );
}

export async function createTempDiffRoot(prefix: string) {
  const rootDir = await fs.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), prefix));
  return {
    rootDir,
    cleanup: () => fs.rm(rootDir, { recursive: true, force: true }),
  };
}

export async function createDiffStoreHarness(
  prefix: string,
  options: { nativeKernel?: boolean } = {},
) {
  const { rootDir: harnessRoot, cleanup } = await createTempDiffRoot(prefix);
  const rootDir = path.join(harnessRoot, "files");
  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: path.join(harnessRoot, "state"),
  };
  const storeOptions: OpenBlobStoreOptions = {
    namespace: "diff-artifacts",
    maxEntries: 2_048,
    maxBytesPerEntry: 32 * 1024 * 1024,
    maxBytesPerNamespace: 256 * 1024 * 1024,
    overflowPolicy: "reject-new",
  };
  const openBlobStore = () =>
    options.nativeKernel
      ? createPluginBlobKernelStore<DiffArtifactBlobMetadata>("diffs", { ...storeOptions, env })
      : createPluginBlobStoreForTests<DiffArtifactBlobMetadata>("diffs", storeOptions, env);
  const openStore = () => {
    const blobStore = openBlobStore();
    return { blobStore, store: new DiffArtifactStore({ rootDir, blobStore }) };
  };
  let current = openStore();
  const close = async () => {
    await current.store.stopCleanup();
    await closeOpenClawStateDatabaseAsync();
    resetPluginBlobStoreForTests();
  };
  return {
    rootDir,
    ...current,
    reopen: async () => {
      await close();
      current = openStore();
      return current;
    },
    cleanup: async () => {
      await close();
      await cleanup();
    },
  };
}
