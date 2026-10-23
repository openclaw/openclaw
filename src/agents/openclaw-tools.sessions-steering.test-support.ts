import { afterEach, expect, it, vi, type Mock } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { getSessionControllerOperation } from "../sessions/session-controller.js";
import * as controllerSteer from "../sessions/session-controller.steer.js";
import { captureSessionTarget } from "../sessions/session-controller.target.js";
import { prepareSystemAgentRunAdmission } from "./admitted-run-context.js";
import {
  detachActiveEmbeddedRun as clearActiveEmbeddedRun,
  attachActiveEmbeddedRun as setActiveEmbeddedRun,
  type EmbeddedAgentQueueHandle,
  type EmbeddedAgentQueueMessageOptions,
} from "./embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "./embedded-agent-runner/runs.test-support.js";
import { withPreparedEmbeddedRunToolAuthority } from "./harness/tool-authority.runtime.js";
import { captureRequesterOrigin } from "./requester-origin.js";
import type { AnyAgentTool } from "./tools/common.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";
import * as sessionsSendFollowup from "./tools/sessions-send-followup-custody.js";
import type { createSessionsSendTool } from "./tools/sessions-send-tool.js";

export function createSessionsSendTestCaller(sessionKey = "agent:re-portal:main") {
  const requesterOrigin = captureRequesterOrigin({
    sessionKey,
    messageProvider: "telegram",
    senderId: "sessions-requester",
  });
  if (!requesterOrigin) {
    throw new Error("sessions-send fixture requires a requester session");
  }
  return {
    agentId: parseAgentSessionKey(sessionKey)?.agentId ?? "main",
    sessionKey,
    requesterOrigin,
  };
}

export function createDurableSessionsSendTestRun(runId: string, afterCommit?: () => Promise<void>) {
  const queueMessage = vi.fn<EmbeddedAgentQueueHandle["queueMessage"]>(async (_text, options) => {
    const recorder = options?.userTurnTranscriptRecorder;
    if (!recorder || !(await recorder.persistApproved())) {
      throw new Error("Steering fixture did not commit the admitted guidance");
    }
    await afterCommit?.();
  });
  const handle = createEmbeddedRunHandle({
    runId,
    queueMessage,
    supportsTranscriptCommitWait: true,
  });
  handle.messageInjectionV2 = queueInjection(queueMessage);
  return { handle, queueMessage };
}

function queueInjection(
  queue: EmbeddedAgentQueueHandle["queueMessage"],
  isAvailable = () => true,
): NonNullable<EmbeddedAgentQueueHandle["messageInjectionV2"]> {
  return {
    version: 2,
    isAvailable,
    queueMessage: async (text, options, assertCurrent) => {
      assertCurrent();
      await queue(text, options);
      options?.onQueueAccepted?.(true);
    },
  };
}

const activeOwners: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(activeOwners.splice(0).map((close) => close()));
});

/** Publish through the same admitted attempt owner as the runtime under test. */
export async function setSessionsSendTestActiveRun(
  sessionId: string,
  handle: EmbeddedAgentQueueHandle,
  sessionKey: string,
  requesterSessionKey: string | undefined,
  config: OpenClawConfig,
  storeScope?: string,
) {
  const caller = createSessionsSendTestCaller(requesterSessionKey);
  const agentId = parseAgentSessionKey(sessionKey)?.agentId ?? "main";
  const storePath = storeScope ?? resolveSessionStorePathCore(config.session?.store, { agentId });
  const target = captureSessionTarget({
    storeScope: storePath,
    sessionKey,
    agentId,
    incarnation: sessionId,
  });
  const operation = getSessionControllerOperation(sessionKey, target);
  const runId = handle.runId ?? `sessions-target:${sessionId}`;
  const sessionFile = `/tmp/${sessionId}.jsonl`;
  const admission = prepareSystemAgentRunAdmission(config, runId, agentId, "sessions-send-test");
  const ready = createDeferred();
  const closed = createDeferred();
  const completion = (async () => {
    try {
      await withPreparedEmbeddedRunToolAuthority(
        {
          admittedRunContext: await admission.admit("embedded", "sessions-send-test"),
          replyOperation: operation,
        },
        {
          sessionId,
          sessionKey,
          runId,
          agentId,
          sessionFile,
          sessionTarget: { agentId, sessionId, sessionKey, storePath },
          workspaceDir: "/tmp/sessions-send-test",
          config,
          provider: "openai",
          modelId: "gpt-test",
          requesterOrigin: caller.requesterOrigin,
        },
        undefined,
        async (prepared) => {
          handle.runId = runId;
          handle.toolAuthorityFingerprint = prepared.toolAuthorityFingerprint;
          setActiveEmbeddedRun(
            sessionId,
            handle,
            sessionKey,
            sessionFile,
            agentId,
            prepared.replyOperation,
          );
          ready.resolve();
          await closed.promise;
        },
      );
    } catch (error) {
      ready.reject(error);
      throw error;
    } finally {
      clearActiveEmbeddedRun(sessionId, handle, sessionKey);
      admission.close();
    }
  })();
  // The owner stays open through the test; cleanup joins any late failure.
  void completion.catch(() => {});
  const close = async () => {
    closed.resolve();
    await completion;
  };
  activeOwners.push(close);
  await ready.promise;
  return close;
}

export async function activeRun(
  sessionKey: string,
  options: {
    config: OpenClawConfig;
    sessionId?: string;
    storeScope?: string;
    requesterSessionKey?: string;
    streaming?: boolean;
    sourceReplyDeliveryMode?: "automatic" | "message_tool_only";
    rejects?: boolean;
    abort?: () => void;
  },
) {
  const queueMessage = vi.fn(async (_text: string, _options?: EmbeddedAgentQueueMessageOptions) => {
    if (options.rejects) {
      throw new Error("active session ended before queued steering message was committed");
    }
    const recorder = _options?.userTurnTranscriptRecorder;
    if (!recorder || !(await recorder.persistApproved())) {
      throw new Error("Steering fixture did not commit the admitted guidance");
    }
  });
  await setSessionsSendTestActiveRun(
    options.sessionId ?? "caller-active-session",
    {
      ...createEmbeddedRunHandle({
        queueMessage,
        abort: options.abort,
        isStopped: () => options.streaming === false,
        supportsTranscriptCommitWait: true,
      }),
      isStreaming: () => options.streaming ?? true,
      messageInjectionV2: queueInjection(queueMessage, () => options.streaming ?? true),
      sourceReplyDeliveryMode: options.sourceReplyDeliveryMode ?? "message_tool_only",
    },
    sessionKey,
    options.requesterSessionKey,
    options.config,
    options.storeScope,
  );
  return queueMessage;
}

export function withTestRequester(tool: AnyAgentTool, sessionKey: string): AnyAgentTool {
  return {
    ...tool,
    execute: (...args) =>
      withGatewayToolCallerIdentity(createSessionsSendTestCaller(sessionKey), () =>
        tool.execute(...args),
      ),
  };
}

export type SessionsSendSteeringFixtures = {
  getSessionTool: (
    name: "sessions_send",
    options: { agentSessionKey: string; agentChannel?: string; config?: OpenClawConfig },
  ) => AnyAgentTool;
  seedSession: (sessionKey: string, sessionId?: string) => Promise<void>;
  callGatewayMock: Mock<
    (request: { method?: string; params?: Record<string, unknown> }) => Promise<unknown>
  >;
  mockGatewayResponses: (responses: Record<string, unknown>) => void;
  settleContinuations: () => Promise<void>;
  cloneTestConfig: () => OpenClawConfig;
};

type SessionsSendActiveSteeringFixtures = SessionsSendSteeringFixtures & {
  mockAcceptedChildFollowup: () => void;
  runChildFollowup: <T>(run: () => Promise<T>) => Promise<T>;
  createSessionsSendTool: (
    options: Omit<NonNullable<Parameters<typeof createSessionsSendTool>[0]>, "callGateway">,
  ) => AnyAgentTool;
};

export function registerSessionsSendActiveSteeringTests({
  mockAcceptedChildFollowup,
  runChildFollowup,
  getSessionTool: createSessionTool,
  seedSession,
  callGatewayMock,
  mockGatewayResponses,
  settleContinuations,
  cloneTestConfig,
  createSessionsSendTool,
}: SessionsSendActiveSteeringFixtures) {
  const getSessionTool: SessionsSendSteeringFixtures["getSessionTool"] = (name, options) =>
    withTestRequester(createSessionTool(name, options), options.agentSessionKey);

  it.each([
    {
      name: "steers a child after durable admission",
      steered: true,
    },
    {
      name: "starts the same child during compaction",
      rejection: "injection_unavailable" as const,
    },
  ])("sessions_send $name", async (testCase) => {
    const { steered, rejection } = testCase;
    const requesterKey = "agent:main:main";
    const targetKey = "agent:main:subagent:steering-child";
    const sessionId = "own-child-active-session";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: targetKey },
      { sessionId, updatedAt: 1, spawnedBy: requesterKey, spawnDepth: 1 },
    );
    const queueMessage = await activeRun(targetKey, {
      config: cloneTestConfig(),
      sessionId,
      requesterSessionKey: requesterKey,
    });
    const queue = vi.spyOn(controllerSteer, "steerSessionControllerOperation");
    const prepare = vi.spyOn(sessionsSendFollowup, "prepareSessionsSendFollowup");
    try {
      if (rejection) {
        queue.mockResolvedValueOnce({ status: "rejected", reason: rejection });
      }
      mockAcceptedChildFollowup();
      const result = await runChildFollowup(() =>
        getSessionTool("sessions_send", {
          agentSessionKey: requesterKey,
        }).execute("child-send", {
          sessionKey: targetKey,
          message: "deps are ready",
          timeoutSeconds: 0,
        }),
      );
      expect(result.details).toMatchObject({
        status: "accepted",
        sessionKey: targetKey,
        targetDisposition: steered ? "steered" : "queued",
        delivery: { status: steered ? "skipped" : "pending" },
      });
      expect(queue).toHaveBeenCalledOnce();
      expect(queue).toHaveBeenCalledWith({
        operation: expect.objectContaining({ sessionId }),
        text: expect.stringContaining("deps are ready"),
        abortOnUnconfirmedTranscript: false,
        options: {
          assertCurrent: expect.any(Function),
          requesterToolAuthority: expect.objectContaining({
            requesterOrigin: expect.objectContaining({ senderId: "sessions-requester" }),
          }),
          steeringMode: "all",
          debounceMs: 0,
          deliveryTimeoutMs: undefined,
          waitForTranscriptCommit: true,
          onQueueAccepted: expect.any(Function),
          userTurnTranscriptRecorder: expect.any(Object),
        },
      });
      if (steered) {
        expect(queueMessage).toHaveBeenCalledOnce();
      }
      const agentCalls = callGatewayMock.mock.calls.filter(
        ([request]) => request.method === "agent",
      );
      expect(agentCalls).toHaveLength(steered ? 0 : 1);
      expect(prepare).toHaveBeenCalledTimes(steered ? 0 : 1);
      if (agentCalls.length) {
        expect(agentCalls[0]?.[0].params).toMatchObject({ sessionKey: targetKey });
        if (rejection) {
          expect(queue.mock.invocationCallOrder[0]).toBeLessThan(
            prepare.mock.invocationCallOrder[0]!,
          );
        }
        expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(
          callGatewayMock.mock.invocationCallOrder[
            callGatewayMock.mock.calls.findIndex(([request]) => request.method === "agent")
          ]!,
        );
      }
    } finally {
      await settleContinuations();
      queue.mockRestore();
      prepare.mockRestore();
    }
  });

  it.each(
    ([undefined, "steer"] as const).flatMap((mode) =>
      ["agent:main:dashboard:self-send", "agent:main:dashboard:self-send:run:captured"].map(
        (key) => ({ mode, key }),
      ),
    ),
  )("sessions_send preserves self-send mode=$mode key=$key", async ({ mode, key }) => {
    await seedSession(key, "self-send-session");
    const queueMessage = await activeRun(key, {
      config: cloneTestConfig(),
      sessionId: "self-send-session",
    });
    mockGatewayResponses({
      agent: { runId: "self-followup", status: "accepted" },
      "agent.wait": { status: "ok", terminalReply: { disposition: "empty" } },
    });
    const tool = withTestRequester(
      createSessionsSendTool({
        agentSessionKey: key,
        requesterOrigin: {
          channel: "telegram",
          accountId: "synthetic-account",
          to: "synthetic-chat",
          threadId: "synthetic-thread",
        },
        config: cloneTestConfig(),
      }),
      key,
    );
    const result = await tool.execute("self-send", {
      sessionKey: key,
      message: "synthetic self followup",
      timeoutSeconds: 0,
      mode,
    });
    expect(result.details).toMatchObject({
      status: "accepted",
      targetDisposition: mode ? "steered" : "queued",
    });
    if (mode) {
      expect(queueMessage).toHaveBeenCalledOnce();
    } else {
      expect(queueMessage).not.toHaveBeenCalled();
    }
    const admissions = callGatewayMock.mock.calls.filter(([request]) => request.method === "agent");
    expect(admissions).toHaveLength(mode ? 0 : 1);
    if (!mode) {
      expect(admissions[0]?.[0].params).toMatchObject({
        sessionKey: key,
        channel: "telegram",
        accountId: "synthetic-account",
        to: "synthetic-chat",
        threadId: "synthetic-thread",
      });
    }
    await settleContinuations();
  });

  it.each(
    ([undefined, "followup"] as const).flatMap((mode) =>
      [false, true].flatMap((busy) =>
        [undefined, 0, 1].map((timeoutSeconds) => ({ mode, busy, timeoutSeconds })),
      ),
    ),
  )(
    "sessions_send mailbox mode=$mode busy=$busy timeout=$timeoutSeconds",
    async ({ mode, busy, timeoutSeconds }) => {
      const key = "agent:main:dashboard:mailbox-recipient";
      await seedSession(key, key);
      const queueMessage = busy
        ? await activeRun(key, { config: cloneTestConfig(), sessionId: key })
        : undefined;
      mockGatewayResponses({
        agent: { runId: "synthetic-input-run", status: "accepted" },
        "agent.wait": {
          status: "ok",
          terminalReply: { disposition: "visible", text: "synthetic idle reply" },
        },
      });
      const result = await getSessionTool("sessions_send", {
        agentSessionKey: "agent:main:dashboard:mailbox-sender",
      }).execute("mailbox-input", {
        sessionKey: key,
        message: "synthetic guidance",
        mode,
        timeoutSeconds,
      });
      expect(result.details).toMatchObject(
        timeoutSeconds === 0
          ? { status: "accepted", targetDisposition: "queued" }
          : { status: "ok", reply: "synthetic idle reply" },
      );
      expect(
        callGatewayMock.mock.calls.filter(
          ([request]) => request.method === "agent" && request.params?.sessionKey === key,
        ),
      ).toHaveLength(1);
      expect(
        callGatewayMock.mock.calls.find(([request]) => request.method === "agent")?.[0].params
          ?.inputProvenance,
      ).toMatchObject({
        kind: "inter_session",
        sourceSessionKey: "agent:main:dashboard:mailbox-sender",
        sourceTool: "sessions_send",
      });
      if (busy) {
        expect(queueMessage).not.toHaveBeenCalled();
        // A zero-wait admission still has the existing detached reply waiter.
        expect(
          callGatewayMock.mock.calls.filter(([request]) => request.method === "agent.wait"),
        ).toHaveLength(1);
      }
      await settleContinuations();
      if (busy) {
        expect(
          callGatewayMock.mock.calls.filter(([request]) => request.method === "agent"),
        ).toHaveLength(1);
      }
    },
  );

  it.each([
    { target: "agent:main:main", unconfirmed: false },
    { target: "main", unconfirmed: false },
    { target: "agent:main:main", unconfirmed: true },
  ])(
    "sessions_send explicitly steers a busy sibling ($target, unconfirmed=$unconfirmed)",
    async ({ target, unconfirmed }) => {
      const calls: Array<{ method?: string; params?: unknown }> = [];
      const ordinaryActiveKey = "agent:main:main";
      const abort = vi.fn();
      await seedSession("agent:main:dashboard:sibling-sender");
      await seedSession(ordinaryActiveKey, "ordinary-active-session");
      const queueMessage = await activeRun(ordinaryActiveKey, {
        config: cloneTestConfig(),
        sessionId: "ordinary-active-session",
        sourceReplyDeliveryMode: "automatic",
        abort,
      });
      queueMessage.mockImplementationOnce(async (_text, options) => {
        expect(options?.waitForTranscriptCommit).toBe(true);
        if (unconfirmed) {
          options?.onQueueAccepted?.(true);
          throw new Error("synthetic consumption confirmation unavailable after acceptance");
        }
        const recorder = options?.userTurnTranscriptRecorder;
        if (!recorder || !(await recorder.persistApproved())) {
          throw new Error("Steering fixture did not commit the admitted guidance");
        }
      });
      callGatewayMock.mockImplementation(async (request) => {
        calls.push(request);
        if (request.method === "sessions.resolve") {
          return { key: ordinaryActiveKey };
        }
        if (request.method === "agent") {
          return { runId: "ordinary-agent-run", status: "accepted", acceptedAt: 2000 };
        }
        return {};
      });

      const tool = getSessionTool("sessions_send", {
        agentSessionKey: "agent:main:dashboard:sibling-sender",
        agentChannel: "telegram",
        config: cloneTestConfig(),
      });

      const result = await tool.execute("call-ordinary-active", {
        sessionKey: target,
        message: "synthetic sibling update",
        mode: "steer",
        timeoutSeconds: 0,
      });

      if (unconfirmed) {
        // Uncertain commitment stays with the receiver and cannot be replayed.
        expect(result.details).toMatchObject({
          status: "error",
          sessionKey: target,
          error: "synthetic consumption confirmation unavailable after acceptance",
        });
      } else {
        expect(result.details).toMatchObject({
          status: "accepted",
          sessionKey: target,
          targetDisposition: "steered",
          delivery: { status: "skipped" },
        });
      }
      expect(queueMessage).toHaveBeenCalledOnce();
      expect(queueMessage).toHaveBeenCalledWith(
        expect.stringContaining("synthetic sibling update"),
        expect.objectContaining({ waitForTranscriptCommit: true }),
      );
      expect(calls.filter((call) => call.method === "agent")).toHaveLength(0);
      expect(calls.filter((call) => call.method === "agent.wait")).toHaveLength(0);
      expect(abort).not.toHaveBeenCalled();
    },
  );
}
