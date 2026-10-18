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
import {
  commandRpcMocks,
  createCodexSessionCatalogControlFactory,
} from "./session-catalog.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("hydrates 490 cold native rollouts and restores them without native reads", async () => {
  const root = await fs.realpath(tempDirs.make("openclaw-cold-native-490-"));
  const fixture = await createNativeCatalogPerformanceFixture(root, {
    count: 490,
    previewBytes: 32 * 1024,
    assistantBytes: 500 * 1024,
  });
  const client = await startNativeCatalogPerformanceClient(fixture);
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
    await control.listPage({ limit: 64 }).then(
      (first) => expect(first.sessions.length).toBeGreaterThan(0),
      (error: unknown) =>
        expect(error).toMatchObject({
          code: "APP_SERVER_UNAVAILABLE",
          message: "Codex session catalog is still loading. Retry shortly.",
        }),
    );
    await control.initialize();
    const entries = (await openState().entries()).map((entry) => entry.value);
    expect(entries.filter((entry) => entry.kind === "row")).toHaveLength(490);
    expect(entries).toContainEqual({ version: 1, kind: "complete" });
    const completedFirst = await control.listPage({ limit: 64 });
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
    const restored = await restartControl.listPage({ limit: 64 });
    expect(restored.sessions.map((session) => session.threadId)).toEqual(
      completedFirst.sessions.map((session) => session.threadId),
    );
    expect(nativeCalls).toHaveLength(beforeRestart);
  } finally {
    await factory.stop();
    await restarted?.stop();
    await client.closeAndWait();
    await closeOpenClawStateDatabaseAsync();
  }
});
