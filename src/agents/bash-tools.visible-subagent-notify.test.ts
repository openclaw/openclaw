import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { dispatchInboundMessageWithRoutedChannelDispatcher } from "../auto-reply/dispatch.js";
import { enqueueSessionEventForHost as enqueueSessionEvent } from "../auto-reply/reply/session-event-handoff.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  setRuntimeConfigSnapshot,
  clearRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { clearAgentRunContext } from "../infra/agent-run-registry.js";
import { peekSystemEventEntries, resetSystemEventsForTest } from "../infra/system-events.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createReplyOperation } from "../sessions/session-controller.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { getFinishedSession, waitForExecScope } from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import {
  fullGatewayExec,
  nodeCommand,
  runningSession,
} from "./bash-tools.lifecycle.test-support.js";
import { createProcessTool } from "./bash-tools.process.js";
import { acknowledgeInternalToolResult } from "./runtime/internal-hooks.js";
import { createSubagentRunRecord } from "./subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "./subagents/registry/subagent-registry-memory.js";

const dispatchMock = vi.hoisted(() =>
  vi.fn<typeof dispatchInboundMessageWithRoutedChannelDispatcher>(),
);
const sendTextMock = vi.hoisted(() =>
  vi.fn(async () => ({
    channel: "telegram" as const,
    messageId: "synthetic-message",
    chatId: "100123",
  })),
);
// mock-isolation: Use synthetic model dispatch with real event admission and outbound delivery.
vi.mock("../auto-reply/dispatch.js", () => ({
  dispatchInboundMessageWithRoutedChannelDispatcher: dispatchMock,
}));
vi.mock("../auto-reply/reply/session-event-handoff.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../auto-reply/reply/session-event-handoff.js")>();
  return { ...actual, enqueueSessionEventForHost: vi.fn(actual.enqueueSessionEventForHost) };
});

const RUN_ID = "visible-exec-channel-fixture";
let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only", prefix: "exec-visible-owner-" });
  vi.mocked(enqueueSessionEvent).mockClear();
  sendTextMock.mockClear();
  const plugin = createOutboundTestPlugin({
    id: "telegram",
    outbound: { deliveryMode: "direct", sendText: sendTextMock },
  });
  setActivePluginRegistry(createTestRegistry([{ pluginId: "telegram", source: "test", plugin }]));
  dispatchMock.mockReset().mockImplementation(async ({ ctx, replyOptions, dispatcherOptions }) => {
    const operation = createReplyOperation({
      sessionKey: String(ctx.SessionKey),
      sessionId: replyOptions!.expectedExistingSessionId!,
      turnKind: "queued_followup",
      resetTriggered: false,
    });
    try {
      replyOptions!.onReplyOperationAdmitted?.(operation);
      await replyOptions!.turnAdoptionLifecycle!.onAdopted();
      await replyOptions!.internalEventExecution!.beforeStart?.();
      replyOptions!.internalEventExecution!.onStarted(RUN_ID);
      await dispatcherOptions.deliver(
        { text: "The background build exited with code 7." },
        { kind: "final" },
      );
      await replyOptions!.internalEventExecution!.onTerminal(RUN_ID, "completed");
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
    } finally {
      operation.complete();
    }
  });
});
afterEach(async () => {
  subagentRuns.delete(RUN_ID);
  clearAgentRunContext(RUN_ID);
  resetProcessRegistryForTests();
  resetSystemEventsForTest();
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
  await state.cleanup();
});

it.skipIf(process.platform === "win32").each([
  ["agent:main:dashboard:borrowed", true, true],
  ["agent:main:subagent:hidden", true, false],
  ["agent:main:dashboard:navigation", false, false],
] as const)(
  "keeps a failed background exec owned by %s (child=%s, borrowed policy=%s)",
  async (sessionKey, child, borrowedPolicy) => {
    const tmpDir = state.root;
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace: tmpDir } },
      channels: { telegram: { allowFrom: ["*"] } },
      session: { store: storePath },
    };
    setRuntimeConfigSnapshot(cfg);
    const delivery = normalizeSessionDeliveryState({
      context: { channel: "telegram", to: "100123" },
    });
    const seedSession = (key: string, sessionId: string, spawnDepth?: number) =>
      replaceSessionEntry(
        { storePath, agentId: "main", sessionKey: key },
        {
          sessionId,
          updatedAt: Date.now(),
          delivery,
          ...(key === sessionKey
            ? { spawnedBy: "agent:main:main", ...(spawnDepth ? { spawnDepth } : {}) }
            : {}),
        },
      );
    await seedSession("agent:main:main", "main-fixture");
    await seedSession(sessionKey, "dashboard-fixture", child ? 1 : undefined);
    const releaseFile = path.join(tmpDir, "release-child");
    const command = nodeCommand(
      [
        'const fs = require("node:fs");',
        `const releaseFile = ${JSON.stringify(releaseFile)};`,
        'const finish = () => { if (fs.existsSync(releaseFile)) { watcher.close(); process.stdout.write("synthetic failed build\\n"); process.exit(7); } };',
        `const watcher = fs.watch(${JSON.stringify(tmpDir)}, finish);`,
        "finish();",
      ].join("\n"),
    );
    const exec = createExecTool({
      config: cfg,
      ...fullGatewayExec,
      allowBackground: true,
      timeoutSec: 10,
      notifyOnExit: true,
      sessionKey: borrowedPolicy ? "agent:main:main" : sessionKey,
      ...(borrowedPolicy ? { runSessionKey: sessionKey } : {}),
      scopeKey: sessionKey,
      messageProvider: "telegram",
      currentChannelId: "100123",
    });
    const started = await exec.execute("background-child", {
      command,
      background: true,
    });
    // Completion retains its producer's policy after the original turn closes.
    clearAgentRunContext(RUN_ID);
    const { sessionId } = runningSession(started.details);
    expect(typeof sessionId).toBe("string");
    // Register and retire the child while its process is waiting, before exit.
    if (child) {
      subagentRuns.set(
        RUN_ID,
        createSubagentRunRecord({ runId: RUN_ID, childSessionKey: sessionKey }),
      );
    }
    subagentRuns.delete(RUN_ID);
    const processTool = createProcessTool({ scopeKey: sessionKey });
    await fs.writeFile(releaseFile, "go");
    await waitForExecScope(sessionKey);
    expect(getFinishedSession(sessionId)?.exitCode).toBe(7);
    expect(enqueueSessionEvent).toHaveBeenCalledTimes(child ? 0 : 1);
    if (!child) {
      const receipt = vi.mocked(enqueueSessionEvent).mock.results[0]!.value;
      await expect(receipt.settled).resolves.toMatchObject({
        status: "completed",
        executionStarted: true,
        delivered: true,
      });
      expect(dispatchMock.mock.calls[0]?.[0].ctx.SessionKey).toBe(sessionKey);
      expect(sendTextMock).toHaveBeenCalledTimes(1);
    } else {
      expect(dispatchMock).not.toHaveBeenCalled();
      expect(sendTextMock).not.toHaveBeenCalled();
      const result = await processTool.execute("poll-child", { action: "poll", sessionId });
      expect(result.details).toMatchObject({ status: "completed", exitCode: 7 });
      expect(peekSystemEventEntries(sessionKey)).toHaveLength(1);
      acknowledgeInternalToolResult(result);
      expect(peekSystemEventEntries(sessionKey)).toEqual([]);
    }
  },
);
