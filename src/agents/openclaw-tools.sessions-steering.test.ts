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
vi.mock("../gateway/call.js", () => ({ callGateway: (opts: unknown) => callGatewayMock(opts) }));
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => config,
  resolveGatewayPort: () => 18789,
}));

import "./test-helpers/fast-openclaw-tools-sessions.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { createSessionConversationTestRegistry } from "../test-utils/session-conversation-registry.js";
import { steerActiveSessionWithOptionalDeliveryWait } from "./embedded-agent-runner/run/attempt-queue-message.js";
import {
  setActiveEmbeddedRun,
  type EmbeddedAgentQueueMessageOptions,
} from "./embedded-agent-runner/runs.js";
import { testing as embeddedRunsTesting } from "./embedded-agent-runner/runs.test-support.js";
import { guardSessionManager } from "./session-tool-result-guard-wrapper.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
} from "./sessions/agent-session-loop-correctness.test-support.js";
import { SessionManager } from "./sessions/session-manager.js";
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

it.each([
  { supportsTranscriptCommitWait: true },
  { supportsTranscriptCommitWait: false },
  { supportsTranscriptCommitWait: true, mode: "steer" as const },
  { supportsTranscriptCommitWait: true, mode: "steer" as const, alternateStore: true },
  { supportsTranscriptCommitWait: true, mode: "steer" as const, hiddenRun: true },
])(
  "sessions_send persists steered provenance with transcript wait support $supportsTranscriptCommitWait and mode $mode, alternate store $alternateStore, hidden run $hiddenRun",
  async ({ supportsTranscriptCommitWait, mode, alternateStore, hiddenRun }) => {
    const calls: Array<{ method?: string }> = [];
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
      const queueMessage = vi.fn((text: string, options?: EmbeddedAgentQueueMessageOptions) =>
        steerActiveSessionWithOptionalDeliveryWait(session, text, options, runScopedCallerKey),
      );
      setActiveEmbeddedRun(
        "caller-active-session",
        {
          ...(hiddenRun ? { runId } : {}),
          queueMessage,
          isStreaming: () => true,
          isCompacting: () => false,
          supportsTranscriptCommitWait,
          sourceReplyDeliveryMode: mode === "steer" ? "automatic" : "message_tool_only",
          abort: () => {},
        },
        runScopedCallerKey,
      );
      if (hiddenRun) {
        registerAgentRunContext(runId, {
          isControlUiVisible: false,
          projectSessionMessages: false,
        });
      }
      callGatewayMock.mockImplementation(async (opts: unknown) => {
        const request = opts as { method?: string };
        calls.push(request);
        if (request.method === "agent") {
          throw new Error("fallback agent should not start");
        }
        return {};
      });

      const tool = createSessionsSendTool({
        callGateway: callGatewayMock,
        agentSessionKey: requesterKey,
        agentChannel: "telegram",
        config: {
          ...config,
          session: {
            ...config.session,
            store: alternateStore
              ? path.join(dir, "agents", "{agentId}", "sessions", "sessions.json")
              : scope.storePath,
          },
        },
      });

      const send = tool
        .execute("call-run-scoped-caller", {
          mode,
          sessionKey: runScopedCallerKey,
          message: "[TASK-COMPLETE] re-portal occupancy ready",
          timeoutSeconds: 0,
        })
        .then((result) => {
          expect(result.details).toEqual(
            expect.objectContaining({ status: "accepted", targetDisposition: "steered" }),
          );
          return result;
        });
      pending.push(send);
      await Promise.race([queued.promise, send, prompt]);
      expect(session.pendingMessageCount).toBe(1);
      finishInitialResponse?.();
      const [result] = await Promise.all([send, prompt]);

      expect(result.details).toEqual(
        expect.objectContaining({
          sessionKey: runScopedCallerKey,
          delivery: expect.objectContaining({ status: "skipped", mode: "announce" }),
        }),
      );
      expect(queueMessage).toHaveBeenCalledOnce();
      expect(queueMessage.mock.calls[0]?.[1]?.waitForTranscriptCommit).toBe(
        supportsTranscriptCommitWait ? true : undefined,
      );
      expect(queueMessage.mock.calls[0]?.[1]?.isInboundUserMessage).toBeUndefined();
      expect(SessionManager.open(scope, dir).getEntries()).toContainEqual(
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
      expect(calls.some((call) => call.method === "agent")).toBe(false);
      expect(listSessionParticipantsReadOnly(scope).get(runScopedCallerKey)).toEqual([
        expect.objectContaining({
          identity: { type: "agent", id: "re-portal" },
          contributionCount: 1,
        }),
      ]);
    } finally {
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
