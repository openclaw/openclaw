import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "../../plugin-sdk/test-helpers/contracts-testkit.js";
import type { PluginHookHandlerMap } from "../../plugins/hook-types.js";
import { createHookRunner } from "../../plugins/hooks.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import {
  createAgentSessionMock,
  hookRunner,
  loadCompactHooksHarness,
  resetCompactHooksHarnessMocks,
  sessionCompactImpl,
  sessionMessages,
} from "./compact.hooks.harness.js";

const sessionId = "noop-hook-session";
const sessionKey = `agent:main:${sessionId}`;
let workspaceDir: string;
let compactDirect: typeof import("./compact.js").compactEmbeddedAgentSessionDirect;
let attachAccounting: typeof import("./run/compaction-accounting-bridge.js").attachCompactionAccountingRecorder;
type AfterCompactionEvent = Parameters<PluginHookHandlerMap["after_compaction"]>[0];
type AfterCompactionContext = Parameters<PluginHookHandlerMap["after_compaction"]>[1];

beforeAll(async () => {
  workspaceDir = await realpath(await mkdtemp(join(tmpdir(), "openclaw-noop-compaction-hook-")));
  const loaded = await loadCompactHooksHarness();
  compactDirect = loaded.compactEmbeddedAgentSessionDirect;
  ({ attachCompactionAccountingRecorder: attachAccounting } =
    await import("./run/compaction-accounting-bridge.js"));
});

beforeEach(async () => {
  resetCompactHooksHarnessMocks(workspaceDir);
  await upsertSessionEntryCore(
    {
      agentId: "main",
      sessionKey,
      storePath: join(workspaceDir, "sessions.json"),
    },
    { sessionId, updatedAt: 1 },
  );
});

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

afterAll(async () => {
  await rm(workspaceDir, { force: true, recursive: true });
});

describe("native no-op compaction hooks", () => {
  it("settles one registered after_compaction observer without changing history or accounting", async () => {
    const observed = createDeferred<{
      event: AfterCompactionEvent;
      context: AfterCompactionContext;
    }>();
    const afterEvents: AfterCompactionEvent[] = [];
    const { config, registry } = createPluginRegistryFixture();
    registerVirtualTestPlugin({
      registry,
      config,
      id: "noop-compaction-observer",
      name: "No-op compaction observer",
      register(api) {
        api.on("after_compaction", (event, context) => {
          afterEvents.push(event);
          observed.resolve({ event, context });
        });
      },
    });
    const registeredRunner = createHookRunner(registry.registry);
    hookRunner.hasHooks.mockImplementation((hookName) =>
      registeredRunner.hasHooks(hookName as never),
    );
    hookRunner.runBeforeCompaction.mockImplementation(
      registeredRunner.runBeforeCompaction as never,
    );
    hookRunner.runAfterCompaction.mockImplementation(registeredRunner.runAfterCompaction as never);

    sessionMessages.splice(0, sessionMessages.length, {
      role: "user",
      content: "<b>HEARTBEAT_OK</b>",
      timestamp: 1,
    });
    const historyBefore = structuredClone(sessionMessages);
    const accountingReceipts: unknown[] = [];
    const contextEngineRuntimeContext = {};
    attachAccounting(contextEngineRuntimeContext, {
      recordCompaction: (receipt) => accountingReceipts.push(receipt),
    });

    const result = await compactDirect({
      agentId: "main",
      sessionId,
      sessionKey,
      sessionFile: join(workspaceDir, "session.jsonl"),
      sessionTarget: {
        agentId: "main",
        sessionId,
        sessionKey,
        storePath: join(workspaceDir, "sessions.json"),
      },
      workspaceDir,
      contextEngineRuntimeContext,
      enqueue: async <T>(task: () => Promise<T> | T) => await task(),
    });
    const { event, context } = await observed.promise;
    const createdSession = await createAgentSessionMock.mock.results[0]?.value;

    expect(result).toMatchObject({
      ok: true,
      compacted: false,
      reason: "no real conversation messages",
    });
    expect(afterEvents).toHaveLength(1);
    expect(event).toMatchObject({
      messageCount: 1,
      tokenCount: 10,
      compactedCount: 0,
      sessionFile: sessionKey,
    });
    expect(context).toMatchObject({
      agentId: "main",
      sessionId,
      sessionKey,
      workspaceDir,
    });
    expect(createdSession?.session.messages).toEqual(historyBefore);
    expect(accountingReceipts).toEqual([]);
    expect(sessionCompactImpl).not.toHaveBeenCalled();
  });
});
