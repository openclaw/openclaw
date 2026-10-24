import assert from "node:assert/strict";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { runBoundedCodexAppServerTurn } from "./app-server/bounded-turn.js";
import * as turns from "./app-server/bounded-turn.test-harness.js";
import { resolveCodexAppServerRuntimeOptions } from "./app-server/config.js";
import type { CodexThread } from "./app-server/protocol.js";
import * as sharedClient from "./app-server/shared-client.js";
import { createClientHarness } from "./app-server/test-support.js";
import {
  codexCatalogResidentHomeKey,
  observeCodexCatalogClient,
} from "./session-catalog-events.js";
import type { StoredCodexCatalogEntry } from "./session-catalog-index-state.js";
import { CodexCatalogIndex } from "./session-catalog-index.js";
import { projectNativeCatalogFixture as projectCodexCatalogPage } from "./session-catalog-projection.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  "excludes helper-owned ephemeral completions across SQLite restart (existing row: %s)",
  async (existing) => {
    const agentDir = tempDirs.make("codex-catalog-ephemeral-");
    const pluginConfig = {};
    const { start } = resolveCodexAppServerRuntimeOptions({ pluginConfig });
    const homeId = await codexCatalogResidentHomeKey({ startOptions: start, agentDir });
    const native = turns.threadStartResult("gpt-5.4");
    Object.assign(native.thread, {
      recencyAt: 100,
      preview: "Name this conversation.",
      source: "cli",
      originator: "codex_cli_rs",
    } satisfies Partial<CodexThread>);
    const openState = () =>
      createPluginStateKeyedStoreForTests<StoredCodexCatalogEntry>("codex", {
        namespace: `ephemeral-${existing}`,
        maxEntries: 20_001,
      });
    const readNative = vi.fn(async () => ({ rows: [] }));
    const createIndex = () =>
      new CodexCatalogIndex({
        homeId,
        localSessionsRoot: path.join(agentDir, "codex-home", "sessions"),
        state: openState(),
        readNative,
        assertCurrent: () => {},
      });
    const index = createIndex();
    const thread: CodexThread = { ...native.thread, source: "cli", status: { type: "idle" } };
    const harness = createClientHarness({
      onWrite: (line, send) => {
        const request: { id: number; method: string; params: { ephemeral?: boolean } } =
          JSON.parse(line);
        const responses: Record<string, unknown> = {
          "model/list": { data: [turns.codexModel()], nextCursor: null },
          "thread/start": native,
          "thread/read": { thread },
          "turn/start": turns.inProgressTurnResult(),
        };
        expect(request.method in responses).toBe(true);
        if (request.method === "thread/start") {
          expect(request.params.ephemeral).toBe(true);
          if (!existing) {
            send({ method: "thread/started", params: { thread } });
          }
        }
        send({ id: request.id, result: responses[request.method] });
        if (request.method === "turn/start") {
          setImmediate(() =>
            send({
              method: "turn/completed",
              params: { threadId: thread.id, ...turns.completedTurnResult() },
            }),
          );
        }
      },
    });
    vi.spyOn(sharedClient, "createIsolatedCodexAppServerClient").mockImplementation(
      async (options) => {
        assert(options?.startOptions, "Expected bounded-turn start options");
        await observeCodexCatalogClient(harness.client, {
          startOptions: options.startOptions,
          agentDir: options.agentDir,
        });
        return harness.client;
      },
    );
    try {
      await index.initialize();
      if (existing) {
        await index.upsertThread({ ...thread, ephemeral: false });
      }
      expect((await index.list({})).sessions).toHaveLength(existing ? 1 : 0);
      const result = await runBoundedCodexAppServerTurn({
        model: { mode: "required", id: "gpt-5.4" },
        timeoutMs: 5_000,
        agentDir,
        options: { pluginConfig },
        taskLabel: "isolated completion",
        developerInstructions: "Answer only.",
        input: [{ type: "text", text: "Name this conversation.", text_elements: [] }],
        requiredModalities: ["text"],
        isolation: "configured-transport",
      });
      expect(result.text).toBe("The message was sent successfully.");
      expect(harness.client.getCloseError()).toBeDefined();
      await nextTurn();
      expect((await index.list({})).sessions).toEqual([]);
      expect(index.get(thread.id)).toBeUndefined();
      expect(harness.writes.some((line) => JSON.parse(line).method === "thread/read")).toBe(true);
    } finally {
      await harness.client.closeAndWait();
      await index.close();
    }
    await closeOpenClawStateDatabaseAsync();
    readNative.mockClear();
    const restarted = createIndex();
    try {
      expect((await restarted.list({})).sessions).toEqual([]);
      expect(readNative).not.toHaveBeenCalled();
      expect((await openState().entries()).filter((entry) => entry.value.kind === "row")).toEqual(
        [],
      );
      expect((await projectCodexCatalogPage({ data: [thread] })).rows).toEqual([]);
    } finally {
      await restarted.close();
    }
  },
);
