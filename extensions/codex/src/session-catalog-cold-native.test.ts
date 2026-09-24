import fs from "node:fs/promises";
import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it } from "vitest";
import type { StoredCodexCatalogEntry } from "./session-catalog-index-state.js";
import {
  createNativeCatalogPerformanceFixture,
  startNativeCatalogPerformanceClient,
} from "./session-catalog-native-performance.test-support.js";
import type { CodexSessionCatalogPage } from "./session-catalog-types.js";
import {
  commandRpcMocks,
  createCodexSessionCatalogControlFactory,
} from "./session-catalog.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("measures first availability, durable hydration, and restart for 490 cold native rollouts", async () => {
  const root = await fs.realpath(tempDirs.make("openclaw-cold-native-490-"));
  const fixture = await createNativeCatalogPerformanceFixture(root, {
    count: 490,
    previewBytes: 32 * 1024,
    assistantBytes: 500 * 1024,
  });
  const nativeStarted = performance.now();
  const client = await startNativeCatalogPerformanceClient(fixture);
  const nativeInitializeMs = performance.now() - nativeStarted;
  const nativeCalls: Array<{ databaseOnly: boolean }> = [];
  commandRpcMocks.codexControlRequest.mockImplementation(
    async (_plugin, method, params, options) => {
      expect(method).toBe("thread/list");
      nativeCalls.push({ databaseOnly: params.useStateDbOnly === true });
      return client.request("thread/list", params, {
        timeoutMs: options.timeoutMs,
        ...(options.catalogPreview ? { catalogPreview: true } : {}),
        ...(options.catalogPreviewCache
          ? { catalogPreviewCache: options.catalogPreviewCache }
          : {}),
      });
    },
  );
  const openState = () =>
    createPluginStateKeyedStoreForTests<StoredCodexCatalogEntry>("codex", {
      namespace: "cold-native-490",
      maxEntries: 20_001,
      env: { OPENCLAW_STATE_DIR: root },
    });
  const createFactory = () =>
    createCodexSessionCatalogControlFactory({
      env: fixture.env,
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      getRuntimeConfig: () => undefined,
      openResidentState: openState,
    });
  const factory = createFactory();
  let restarted: ReturnType<typeof createFactory> | undefined;
  try {
    const source = (await factory.homesForAgent("main"))[0]!;
    const control = factory.forRequest("main", source);
    expect(nativeCalls).toHaveLength(0);
    const started = performance.now();
    let first: CodexSessionCatalogPage | undefined;
    let firstError: unknown;
    try {
      first = await control.listPage({ limit: 64 });
    } catch (error) {
      firstError = error;
    }
    const firstCall = {
      outcome: firstError ? "error" : first?.sessions.length ? "data" : "empty",
      elapsedMs: performance.now() - started,
      sinceNativeLaunchMs: performance.now() - nativeStarted,
      rows: first?.sessions.length ?? 0,
      hasCursor: Boolean(first?.nextCursor),
      nativeCalls: nativeCalls.length,
    };
    console.info(
      "cold native first catalog list",
      JSON.stringify({
        fixtureRows: 490,
        rolloutBytes: fixture.rolloutBytes,
        firstCall,
      }),
    );
    if (firstError) {
      expect(firstError).toMatchObject({
        code: "APP_SERVER_UNAVAILABLE",
        message: "Codex session catalog is still loading. Retry shortly.",
      });
      firstCall.outcome = "retry";
    } else {
      expect(first?.sessions.length).toBeGreaterThan(0);
    }
    await control.initialize();
    const entries = (await openState().entries()).map((entry) => entry.value);
    expect(entries.filter((entry) => entry.kind === "row")).toHaveLength(490);
    expect(entries).toContainEqual({ version: 1, kind: "complete" });
    const completeHydrationMs = performance.now() - started;
    const durableSinceNativeLaunchMs = performance.now() - nativeStarted;
    const completedFirst = await control.listPage({ limit: 64 });
    const firstObservedDataMs = first?.sessions.length
      ? firstCall.elapsedMs
      : performance.now() - started;
    expect(completedFirst.sessions).toHaveLength(64);
    const ids = completedFirst.sessions.map((session) => session.threadId);
    let cursor = completedFirst.nextCursor;
    while (cursor) {
      const page = await control.listPage({ limit: 64, cursor });
      ids.push(...page.sessions.map((session) => session.threadId));
      cursor = page.nextCursor;
    }
    expect(new Set(ids).size).toBe(490);
    expect(nativeCalls).toHaveLength(8);
    expect(nativeCalls.every((call) => !call.databaseOnly)).toBe(true);
    await factory.stop();
    await closeOpenClawStateDatabaseAsync();

    restarted = createFactory();
    const restartSource = (await restarted.homesForAgent("main"))[0]!;
    const restartControl = restarted.forRequest("main", restartSource);
    const beforeRestart = nativeCalls.length;
    const restartStarted = performance.now();
    const restored = await restartControl.listPage({ limit: 64 });
    const restartFirstListMs = performance.now() - restartStarted;
    const restartNativeCalls = nativeCalls.length - beforeRestart;
    expect(restored.sessions.map((session) => session.threadId)).toEqual(
      completedFirst.sessions.map((session) => session.threadId),
    );
    expect(restartNativeCalls).toBe(0);
    console.info(
      "cold native catalog measurements",
      JSON.stringify({
        fixtureRows: 490,
        previewBytesPerRollout: 32 * 1024,
        assistantBytesPerRollout: 500 * 1024,
        rolloutBytes: fixture.rolloutBytes,
        nativeInitializeMs,
        firstCall,
        firstObservedDataMs,
        firstDataObservedAt: first?.sessions.length ? "first list" : "list after full hydration",
        completeHydrationMs,
        durableSinceNativeLaunchMs,
        completeNativePages: beforeRestart,
        durableRows: entries.filter((entry) => entry.kind === "row").length,
        restartFirstListMs,
        restartRows: restored.sessions.length,
        restartNativeCalls,
      }),
    );
  } finally {
    await factory.stop();
    await restarted?.stop();
    await client.closeAndWait();
    await closeOpenClawStateDatabaseAsync();
  }
});
