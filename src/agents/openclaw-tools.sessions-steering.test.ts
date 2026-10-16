import path from "node:path";
import { createAssistantMessageEventStream, type Model } from "openclaw/plugin-sdk/llm";
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
    const requesterKey = "agent:re-portal:main";
    const targetKey = "agent:leasing-ops:dashboard:active-target";
    const dir = tempDirs.make("openclaw-sessions-requester-refusal-");
    const storePath = path.join(dir, "sessions.json");
    await upsertSessionEntryCore(
      { agentId: "leasing-ops", sessionKey: targetKey, storePath },
      { sessionId: "caller-active-session", updatedAt: 1 },
    );
    await upsertSessionEntryCore(
      { agentId: "re-portal", sessionKey: requesterKey, storePath },
      { sessionId: "requester-session", updatedAt: 1 },
    );
    const testConfig = { ...config, session: { ...config.session, store: storePath } };
    const queue = await activeRun(targetKey, {
      config: testConfig,
      requesterSessionKey: requesterKey,
    });
    const caller = createSessionsSendTestCaller(requesterKey);
    const tool = createSessionsSendTool({
      agentSessionKey: requesterKey,
      agentChannel: "telegram",
      callGateway: callGatewayMock,
      config: testConfig,
    });
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
  { supportsTranscriptCommitWait: false },
  { supportsTranscriptCommitWait: true },
  {
    supportsTranscriptCommitWait: true,
    mode: "steer" as const,
    alternateStore: true,
    refreshedDisplay: true,
  },
  { supportsTranscriptCommitWait: true, mode: "steer" as const, hiddenRun: true },
])(
  "sessions_send persists steered provenance with transcript wait support $supportsTranscriptCommitWait and mode $mode, alternate store $alternateStore, hidden run $hiddenRun, refreshed display $refreshedDisplay",
  async ({ supportsTranscriptCommitWait, mode, alternateStore, hiddenRun, refreshedDisplay }) => {
    const runId = "hidden-sessions-send-steering-run";
    const runScopedCallerKey =
      mode === "steer"
        ? "agent:leasing-ops:dashboard:active-target"
        : "agent:leasing-ops:cron:monthly-utility:run:run-fast";
    const requesterKey = "agent:re-portal:main";
    const dir = tempDirs.make("openclaw-sessions-steered-provenance-");
    const scope = {
      agentId: "leasing-ops",
      sessionId: "caller-active-session",
      sessionKey: runScopedCallerKey,
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
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: Date.now() });
    const sessionManager = SessionManager.open(scope, dir);
    guardSessionManager(sessionManager);
    const { session } = await createTestSession({ sessionManager });
    let finishInitialResponse: (() => void) | undefined;
    let closing = false;
    const initialResponseStarted = createDeferred();
    const queued = createDeferred();
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "queue_update") {
        queued.resolve();
      }
    });
    streamMocks.streamSimple.mockImplementation((model: Model) => {
      if (finishInitialResponse || closing) {
        return createAssistantResultStream(
          createAssistant(model, [{ type: "text", text: "received" }]),
        );
      }
      const stream = createAssistantMessageEventStream();
      finishInitialResponse = () => {
        stream.push({
          type: "done",
          reason: "stop",
          message: createAssistant(model, [{ type: "text", text: "ready" }]),
        });
        stream.end();
      };
      initialResponseStarted.resolve();
      return stream;
    });
    const prompt = session.prompt("wait for another session");
    const pending: Promise<unknown>[] = [prompt];
    try {
      // Dispatch can await transport initialization; synchronize on provider entry.
      await Promise.race([initialResponseStarted.promise, prompt]);
      expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
      const queueMessage = vi.fn(
        (text: string, options?: EmbeddedAgentQueueMessageOptions, assertCurrent?: () => void) =>
          steerActiveSessionWithOptionalDeliveryWait(
            session,
            text,
            options,
            runScopedCallerKey,
            () => {
              assertCurrent?.();
              return true;
            },
          ),
      );
      await setSessionsSendTestActiveRun(
        "caller-active-session",
        {
          ...(hiddenRun ? { runId } : {}),
          queueMessage,
          messageInjectionV2: { version: 2, isAvailable: () => true, queueMessage },
          isStreaming: () => true,
          isCompacting: () => false,
          supportsTranscriptCommitWait,
          sourceReplyDeliveryMode: mode === "steer" ? "automatic" : "message_tool_only",
          abort: () => {},
        },
        runScopedCallerKey,
        requesterKey,
        testConfig,
      );
      if (hiddenRun) {
        registerAgentRunContext(runId, {
          isControlUiVisible: false,
          projectSessionMessages: false,
        });
      }
      callGatewayMock.mockImplementation(async (opts: unknown) => {
        const request = opts as { method?: string };
        if (request.method === "agent") {
          throw new Error("fallback agent should not start");
        }
        return {};
      });

      const tool = createSessionsSendTool({
        callGateway: callGatewayMock,
        agentSessionKey: requesterKey,
        agentChannel: "telegram",
        config: testConfig,
      });

      if (mode === "steer") {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      }
      const caller = createSessionsSendTestCaller(requesterKey);
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
          sessionKey: runScopedCallerKey,
          message: "[TASK-COMPLETE] re-portal occupancy ready",
          timeoutSeconds: 0,
        }),
      );
      pending.push(send);
      await Promise.race([queued.promise, send, prompt]);
      expect(session.pendingMessageCount).toBe(1);
      if (mode === "steer") {
        // The active response is still held: an admission-only send must not
        // withdraw guidance when the unrelated reply-wait deadline expires.
        await vi.advanceTimersByTimeAsync(30_000);
        vi.useRealTimers();
        expect((await send).details).toMatchObject({ status: "accepted" });
        expect(session.pendingMessageCount).toBe(1);
        expect(
          SessionManager.open(scope, dir)
            .getEntries()
            .filter((entry) => entry.type === "message" && entry.message.role === "user"),
        ).toHaveLength(1);
      }
      finishInitialResponse?.();
      const [result] = await Promise.all([send, prompt]);

      expect(result.details).toMatchObject({
        status: "accepted",
        targetDisposition: "steered",
        sessionKey: runScopedCallerKey,
        delivery: { status: "skipped" },
      });
      expect(queueMessage).toHaveBeenCalledOnce();
      expect(queueMessage.mock.calls[0]?.[1]?.waitForTranscriptCommit).toBe(
        mode === "steer" ? false : supportsTranscriptCommitWait ? true : undefined,
      );
      expect(queueMessage.mock.calls[0]?.[1]?.isInboundUserMessage).toBeUndefined();
      const entries = SessionManager.open(scope, dir).getEntries();
      expect(
        entries.filter((entry) => entry.type === "message" && entry.message.role === "user"),
      ).toHaveLength(2);
      expect(session.pendingMessageCount).toBe(0);
      expect(entries).toContainEqual(
        expect.objectContaining({
          type: "message",
          message: expect.objectContaining({
            role: "user",
            provenance: {
              kind: "inter_session",
              sourceSessionKey: requesterKey,
              sourceChannel: "telegram",
              sourceTool: "sessions_send",
            },
          }),
        }),
      );
      expect(callGatewayMock.mock.calls.some(([request]) => request.method === "agent")).toBe(
        false,
      );
      await waitForSessionParticipantRecording(scope);
      expect(listSessionParticipantsReadOnly(scope).get(runScopedCallerKey)).toEqual([
        expect.objectContaining({
          identity: { type: "agent", id: "re-portal" },
          contributionCount: 1,
        }),
      ]);
    } finally {
      vi.useRealTimers();
      // Release even a late provider callback, then join work before fixture teardown.
      closing = true;
      unsubscribe();
      finishInitialResponse?.();
      await session.abort();
      await Promise.allSettled(pending);
      clearAgentRunContext(runId);
    }
  },
);
