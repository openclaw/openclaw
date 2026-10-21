import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  listSessionParticipantsReadOnly,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";

const { config, callGatewayMock } = vi.hoisted(() => ({
  config: {
    session: { mainKey: "main", scope: "per-sender" },
    tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true } },
  } satisfies OpenClawConfig,
  callGatewayMock: vi.fn(),
}));
// mock-isolation: Steering stays in this receiver; unexpected RPCs must hit the spy, never a live Gateway.
vi.mock("../gateway/call.js", () => ({ callGateway: (opts: unknown) => callGatewayMock(opts) }));
// mock-isolation: Pin this routing fixture; live config publication is covered by Gateway admission tests.
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => config,
  resolveGatewayPort: () => 18789,
}));

import "./test-helpers/fast-openclaw-tools-sessions.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { waitForSessionParticipantRecording } from "../sessions/session-participant-recording.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { createSessionConversationTestRegistry } from "../test-utils/session-conversation-registry.js";
import { steerActiveSessionWithOptionalDeliveryWait } from "./embedded-agent-runner/run/attempt-queue-message.js";
import type { EmbeddedAgentQueueMessageOptions } from "./embedded-agent-runner/runs.js";
import { testing as embeddedRunsTesting } from "./embedded-agent-runner/runs.test-support.js";
import {
  activeRun,
  createSessionsSendTestCaller,
  setSessionsSendTestActiveRun,
} from "./openclaw-tools.sessions-steering.test-support.js";
import { guardSessionManager } from "./session-tool-result-guard-wrapper.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  holdAssistantResponse,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
} from "./sessions/agent-session-loop-correctness.test-support.js";
import { SessionManager } from "./sessions/session-manager.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";
import { createSessionsSendTool } from "./tools/sessions-send-tool.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const dir of tempDirs.dirs) {
      await closeOpenClawAgentDatabasesAsync(dir);
    }
    cleanup();
  }),
);
const requesterKey = "agent:re-portal:main";
function sendTool(testConfig: OpenClawConfig, callerKey = requesterKey) {
  return createSessionsSendTool({
    agentSessionKey: callerKey,
    agentChannel: "telegram",
    callGateway: callGatewayMock,
    config: testConfig,
  });
}
function userEntries(scope: Parameters<typeof SessionManager.open>[0], dir: string) {
  return SessionManager.open(scope, dir)
    .getEntries()
    .flatMap((entry) =>
      entry.type === "message" && entry.message.role === "user" ? [entry.message] : [],
    );
}
async function steeringFixture(sessionKey: string, alternateStore = false, updatedAt = Date.now()) {
  const dir = tempDirs.make("openclaw-steering-");
  const scope = {
    agentId: "leasing-ops",
    sessionId: "caller-active-session",
    sessionKey,
    storePath: alternateStore
      ? resolveSessionStorePathCore(undefined, { agentId: "leasing-ops" })
      : path.join(dir, "sessions.json"),
  };
  const testConfig = {
    ...config,
    session: {
      ...config.session,
      store: alternateStore
        ? path.join(dir, "agents", "{agentId}", "sessions", "sessions.json")
        : scope.storePath,
    },
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt });
  return { dir, scope, testConfig };
}
registerAgentSessionLoopTestLifecycle();
beforeEach(() => {
  resetGatewayWorkAdmission();
  callGatewayMock.mockReset();
  embeddedRunsTesting.resetActiveEmbeddedRuns();
  setActivePluginRegistry(createSessionConversationTestRegistry());
});
afterEach(() => {
  resetGatewayWorkAdmission();
  embeddedRunsTesting.resetActiveEmbeddedRuns();
});

it.each(["missing", "different", "different account"] as const)(
  "explicit sessions_send steering refuses %s requester identity without starting other work",
  async (identity) => {
    const targetKey = "agent:leasing-ops:dashboard:active-target";
    const {
      scope: { storePath },
      testConfig,
    } = await steeringFixture(targetKey, false, 1);
    await upsertSessionEntryCore(
      { agentId: "re-portal", sessionKey: requesterKey, storePath },
      { sessionId: "requester-session", updatedAt: 1 },
    );
    const queue = await activeRun(targetKey, {
      config: testConfig,
      requesterSessionKey: requesterKey,
    });
    const caller = createSessionsSendTestCaller(requesterKey);
    const tool = sendTool(testConfig);
    const result = await withGatewayToolCallerIdentity(
      identity === "missing"
        ? undefined
        : {
            ...caller,
            requesterOrigin: {
              ...caller.requesterOrigin,
              ...(identity === "different" ? { senderId: "bob" } : { accountId: "other-account" }),
            },
          },
      () =>
        tool.execute("refused-steer", {
          mode: "steer",
          sessionKey: targetKey,
          message: "stop the current work",
          timeoutSeconds: 0,
        }),
    );
    expect(result.details).toMatchObject({
      status: "error",
      error: expect.stringContaining('mode: "followup"'),
    });
    expect(queue).not.toHaveBeenCalled();
    expect(callGatewayMock.mock.calls.map(([request]) => request.method)).toEqual([
      "sessions.resolve",
    ]);
  },
);

it.each([
  [undefined, false, false, false, false],
  ["steer", true, false, true, false],
  ["steer", false, true, false, false],
  [undefined, false, false, false, true],
] as const)(
  "persists steering provenance: mode=%s alternateStore=%s hiddenRun=%s refreshedDisplay=%s ownChild=%s",
  async (mode, alternateStore, hiddenRun, refreshedDisplay, ownChild) => {
    const runId = "hidden-sessions-send-steering-run";
    const sessionKey = ownChild
      ? "agent:leasing-ops:subagent:active-child"
      : mode === "steer"
        ? "agent:leasing-ops:dashboard:active-target"
        : "agent:leasing-ops:cron:monthly-utility:run:run-fast";
    const callerKey = ownChild ? "agent:leasing-ops:main" : requesterKey;
    const { dir, scope, testConfig } = await steeringFixture(sessionKey, alternateStore);
    if (ownChild) {
      await upsertSessionEntryCore(
        { ...scope, sessionKey: callerKey },
        { sessionId: "parent-session", updatedAt: Date.now() },
      );
      await upsertSessionEntryCore(scope, {
        sessionId: scope.sessionId,
        updatedAt: Date.now(),
        spawnedBy: callerKey,
        spawnDepth: 1,
      });
    }
    const sessionManager = SessionManager.open(scope, dir);
    guardSessionManager(sessionManager);
    const { session } = await createTestSession({ sessionManager });
    const held = holdAssistantResponse("ready");
    let responding = false;
    let closing = false;
    const initialResponseStarted = createDeferred();
    const queued = createDeferred();
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "queue_update") {
        queued.resolve();
      }
    });
    streamMocks.streamSimple.mockImplementation((model) => {
      if (responding || closing) {
        return createAssistantResultStream(createAssistant(model, "received"));
      }
      responding = true;
      initialResponseStarted.resolve();
      return held.response;
    });
    const prompt = session.prompt("wait for another session");
    const pending: Promise<unknown>[] = [prompt];
    try {
      // Dispatch can await transport initialization; synchronize on provider entry.
      await Promise.race([initialResponseStarted.promise, prompt]);
      expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
      const queueMessage = vi.fn(
        (text: string, options?: EmbeddedAgentQueueMessageOptions, assertCurrent?: () => void) =>
          steerActiveSessionWithOptionalDeliveryWait(session, text, options, sessionKey, () => {
            assertCurrent?.();
            return true;
          }),
      );
      await setSessionsSendTestActiveRun(
        "caller-active-session",
        {
          ...(hiddenRun ? { runId } : {}),
          queueMessage,
          messageInjectionV2: { version: 2, isAvailable: () => true, queueMessage },
          isStreaming: () => true,
          isCompacting: () => false,
          supportsTranscriptCommitWait: true,
          sourceReplyDeliveryMode: mode === "steer" ? "automatic" : "message_tool_only",
          abort: () => {},
        },
        sessionKey,
        callerKey,
        testConfig,
        scope.storePath,
      );
      if (hiddenRun) {
        registerAgentRunContext(runId, {
          isControlUiVisible: false,
          projectSessionMessages: false,
        });
      }
      callGatewayMock.mockImplementation(async ({ method }: { method?: string }) => {
        if (method === "agent") {
          throw new Error("fallback agent should not start");
        }
        return {};
      });

      const tool = sendTool(testConfig, callerKey);

      if (mode === "steer" || ownChild) {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      }
      const caller = createSessionsSendTestCaller(callerKey);
      if (refreshedDisplay) {
        caller.requesterOrigin = {
          ...caller.requesterOrigin,
          senderName: "Updated requester name",
          senderUsername: "updated-requester",
        };
      }
      const send = withGatewayToolCallerIdentity(caller, () =>
        tool.execute("call-run-scoped-caller", {
          mode,
          sessionKey,
          message: "[TASK-COMPLETE] re-portal occupancy ready",
          timeoutSeconds: 0,
        }),
      );
      let acknowledged = false;
      void send.then(() => {
        acknowledged = true;
      });
      pending.push(send);
      await Promise.race([queued.promise, send, prompt]);
      expect(session.pendingMessageCount).toBe(1);
      if (mode === "steer" || ownChild) {
        // A reply-wait deadline cannot turn volatile steering into a durable ACK.
        await vi.advanceTimersByTimeAsync(30_000);
        vi.useRealTimers();
        expect(acknowledged).toBe(false);
        expect(session.pendingMessageCount).toBe(1);
        expect(userEntries(scope, dir)).toHaveLength(1);
      }
      held.release();
      const [result] = await Promise.all([send, prompt]);

      expect(result.details).toMatchObject({
        status: "accepted",
        targetDisposition: "steered",
        sessionKey,
        delivery: { status: "skipped" },
      });
      expect(queueMessage).toHaveBeenCalledOnce();
      expect(queueMessage.mock.calls[0]?.[1]?.isInboundUserMessage).toBeUndefined();
      const entries = userEntries(scope, dir);
      expect(entries).toHaveLength(2);
      expect(session.pendingMessageCount).toBe(0);
      expect(entries).toContainEqual(
        expect.objectContaining({
          provenance: {
            kind: "inter_session",
            sourceSessionKey: callerKey,
            sourceChannel: "telegram",
            sourceTool: "sessions_send",
          },
        }),
      );
      expect(callGatewayMock.mock.calls.some(([request]) => request.method === "agent")).toBe(
        false,
      );
      await waitForSessionParticipantRecording(scope);
      const participants = listSessionParticipantsReadOnly(scope).get(sessionKey);
      if (ownChild) {
        expect(participants).toBeUndefined();
      } else {
        expect(participants).toEqual([
          expect.objectContaining({
            identity: { type: "agent", id: "re-portal" },
            contributionCount: 1,
          }),
        ]);
      }
    } finally {
      vi.useRealTimers();
      // Release even a late provider callback, then join work before fixture teardown.
      closing = true;
      unsubscribe();
      held.release();
      await session.abort();
      await Promise.allSettled(pending);
      clearAgentRunContext(runId);
    }
  },
);
