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

async function persistGuidance(options?: EmbeddedAgentQueueMessageOptions) {
  const recorder = options?.userTurnTranscriptRecorder;
  if (!recorder || !(await recorder.persistApproved())) {
    throw new Error("Steering fixture did not commit the admitted guidance");
  }
}

export function createDurableSessionsSendTestRun(runId: string, afterCommit?: () => Promise<void>) {
  const queueMessage = vi.fn<EmbeddedAgentQueueHandle["queueMessage"]>(async (_text, options) => {
    await persistGuidance(options);
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
    await persistGuidance(_options);
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
}: SessionsSendActiveSteeringFixtures) {
  const getSessionTool: SessionsSendSteeringFixtures["getSessionTool"] = (name, options) =>
    withTestRequester(createSessionTool(name, options), options.agentSessionKey);
  const gatewayCalls = (method: string) =>
    callGatewayMock.mock.calls.filter(([request]) => request.method === method);

  it("sessions_send starts the same child during compaction", async () => {
    const requesterKey = "agent:main:main";
    const targetKey = "agent:main:subagent:steering-child";
    const sessionId = "own-child-active-session";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: targetKey },
      { sessionId, updatedAt: 1, spawnedBy: requesterKey, spawnDepth: 1 },
    );
    await activeRun(targetKey, {
      config: cloneTestConfig(),
      sessionId,
      requesterSessionKey: requesterKey,
    });
    const queue = vi.spyOn(controllerSteer, "steerSessionControllerOperation");
    const prepare = vi.spyOn(sessionsSendFollowup, "prepareSessionsSendFollowup");
    try {
      queue.mockResolvedValueOnce({ status: "rejected", reason: "injection_unavailable" });
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
        targetDisposition: "queued",
        delivery: { status: "pending" },
      });
      expect(queue.mock.calls[0]?.[0]).toMatchObject({
        operation: { sessionId },
        text: expect.stringContaining("deps are ready"),
        abortOnUnconfirmedTranscript: false,
        options: {
          requesterToolAuthority: { requesterOrigin: { senderId: "sessions-requester" } },
          waitForTranscriptCommit: true,
        },
      });
      const agentCalls = gatewayCalls("agent");
      expect(agentCalls).toHaveLength(1);
      expect(agentCalls[0]?.[0].params).toMatchObject({ sessionKey: targetKey });
      expect(queue.mock.invocationCallOrder[0]).toBeLessThan(prepare.mock.invocationCallOrder[0]!);
      expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(
        callGatewayMock.mock.invocationCallOrder[
          callGatewayMock.mock.calls.findIndex(([request]) => request.method === "agent")
        ]!,
      );
    } finally {
      await settleContinuations();
      queue.mockRestore();
      prepare.mockRestore();
    }
  });

  it.each(["agent:main:dashboard:self-send", "agent:main:dashboard:self-send:run:captured"])(
    "sessions_send explicitly steers itself (%s)",
    async (key) => {
      await seedSession(key, "self-send-session");
      const queueMessage = await activeRun(key, {
        config: cloneTestConfig(),
        sessionId: "self-send-session",
      });
      const result = await getSessionTool("sessions_send", { agentSessionKey: key }).execute(
        "self-send",
        {
          sessionKey: key,
          message: "synthetic self followup",
          timeoutSeconds: 0,
          mode: "steer",
        },
      );
      expect(result.details).toMatchObject({ status: "accepted", targetDisposition: "steered" });
      expect(queueMessage).toHaveBeenCalledOnce();
      expect(gatewayCalls("agent")).toEqual([]);
      await settleContinuations();
    },
  );

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
        gatewayCalls("agent").filter(([request]) => request.params?.sessionKey === key),
      ).toHaveLength(1);
      expect(gatewayCalls("agent")[0]?.[0].params?.inputProvenance).toMatchObject({
        kind: "inter_session",
        sourceSessionKey: "agent:main:dashboard:mailbox-sender",
        sourceTool: "sessions_send",
      });
      if (busy) {
        expect(queueMessage).not.toHaveBeenCalled();
        // A zero-wait admission still has the existing detached reply waiter.
        expect(gatewayCalls("agent.wait")).toHaveLength(1);
      }
      await settleContinuations();
      if (busy) {
        expect(gatewayCalls("agent")).toHaveLength(1);
      }
    },
  );

  it("sessions_send never replays uncertain sibling steering", async () => {
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
      options?.onQueueAccepted?.(true);
      throw new Error("synthetic consumption confirmation unavailable after acceptance");
    });
    mockGatewayResponses({
      "sessions.resolve": { key: ordinaryActiveKey },
      agent: { runId: "ordinary-agent-run", status: "accepted", acceptedAt: 2000 },
    });

    const tool = getSessionTool("sessions_send", {
      agentSessionKey: "agent:main:dashboard:sibling-sender",
      agentChannel: "telegram",
      config: cloneTestConfig(),
    });

    const result = await tool.execute("call-ordinary-active", {
      sessionKey: ordinaryActiveKey,
      message: "synthetic sibling update",
      mode: "steer",
      timeoutSeconds: 0,
    });

    // Uncertain commitment stays with the receiver and cannot be replayed.
    expect(result.details).toMatchObject({
      status: "error",
      sessionKey: ordinaryActiveKey,
      error: "synthetic consumption confirmation unavailable after acceptance",
    });
    expect(queueMessage).toHaveBeenCalledOnce();
    expect(queueMessage.mock.calls[0]).toMatchObject([
      expect.stringContaining("synthetic sibling update"),
      { waitForTranscriptCommit: true },
    ]);
    expect([gatewayCalls("agent"), gatewayCalls("agent.wait")]).toEqual([[], []]);
    expect(abort).not.toHaveBeenCalled();
  });
}
