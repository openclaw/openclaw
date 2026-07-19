// Steering authorization tests cover active-run ownership, trusted harness
// access, and attempt-bound handoff capabilities.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import { testing as replyRunTesting } from "../../auto-reply/reply/reply-run-registry.test-support.js";
import {
  createSteeringAuthorizationAffinity,
  type SteeringAuthorizationAffinity,
} from "../../auto-reply/reply/steering-authorization-affinity.js";
import {
  createOperatorTurnAuthoritySnapshot,
  createTurnAuthoritySnapshot,
} from "../../plugins/turn-authority.js";
import {
  abortActiveRunWithSteeringAuthorization,
  captureActiveEmbeddedRunSteeringTarget,
  queueEmbeddedAgentHarnessMessageWithOutcome,
  queueEmbeddedAgentMessageWithOutcome,
  queueEmbeddedAgentMessageWithOutcomeAsync,
  setActiveEmbeddedRun,
} from "./runs.js";
import { testing } from "./runs.test-support.js";

type RunHandle = Parameters<typeof setActiveEmbeddedRun>[1];

const TEST_STEERING_AUTHORIZATION_AFFINITY = createSteeringAuthorizationAffinity({
  turnAuthority: createTurnAuthoritySnapshot({
    principal: { kind: "service", serviceId: "runs-test" },
    agentId: "main",
    sessionKey: "agent:main:main",
    conversationId: "agent:main:main",
    controllerKey: "service:runs-test",
  }),
});

function createRunHandle(
  overrides: {
    abort?: () => void;
    queueMessage?: RunHandle["queueMessage"];
    runId?: string;
    steeringAuthorizationAffinity?: SteeringAuthorizationAffinity;
    supportsQueueMessageImages?: boolean;
  } = {},
): RunHandle {
  return {
    runId: overrides.runId,
    queueMessage: overrides.queueMessage ?? (async () => {}),
    isStreaming: () => true,
    isCompacting: () => false,
    steeringAuthorizationAffinity: overrides.steeringAuthorizationAffinity,
    supportsQueueMessageImages: overrides.supportsQueueMessageImages,
    abort: overrides.abort ?? (() => {}),
  };
}

function createSteerableRunHandle(
  overrides: Parameters<typeof createRunHandle>[0] = {},
): RunHandle {
  return createRunHandle({
    ...overrides,
    steeringAuthorizationAffinity: TEST_STEERING_AUTHORIZATION_AFFINITY,
  });
}

describe("embedded-agent runner steering authorization", () => {
  afterEach(() => {
    testing.resetActiveEmbeddedRuns();
    replyRunTesting.resetReplyRunRegistry();
    vi.restoreAllMocks();
  });

  it("passes steering options to active embedded runs", () => {
    const queueMessage = vi.fn(async () => {});
    setActiveEmbeddedRun("session-steer", {
      ...createSteerableRunHandle(),
      sourceReplyDeliveryMode: "message_tool_only",
      queueMessage,
    });

    expect(
      queueEmbeddedAgentMessageWithOutcome("session-steer", "continue", {
        steeringMode: "all",
        sourceReplyDeliveryMode: "message_tool_only",
        steeringAuthorizationAffinity: TEST_STEERING_AUTHORIZATION_AFFINITY,
      }).queued,
    ).toBe(true);

    expect(queueMessage).toHaveBeenCalledWith("continue", {
      steeringMode: "all",
      sourceReplyDeliveryMode: "message_tool_only",
      steeringAuthorizationAffinity: TEST_STEERING_AUTHORIZATION_AFFINITY,
    });
  });

  it("rejects images when the active run cannot preserve them", () => {
    const queueMessage = vi.fn(async () => {});
    setActiveEmbeddedRun("session-images", {
      ...createSteerableRunHandle(),
      queueMessage,
    });

    const outcome = queueEmbeddedAgentMessageWithOutcome("session-images", "inspect", {
      images: [{ type: "image", data: "png", mimeType: "image/png" }],
      steeringAuthorizationAffinity: TEST_STEERING_AUTHORIZATION_AFFINITY,
    });

    expect(outcome).toEqual({
      queued: false,
      sessionId: "session-images",
      reason: "image_input_unsupported",
      gatewayHealth: "live",
    });
    expect(queueMessage).not.toHaveBeenCalled();

    setActiveEmbeddedRun(
      "session-images",
      createSteerableRunHandle({ queueMessage, supportsQueueMessageImages: true }),
    );

    expect(
      queueEmbeddedAgentMessageWithOutcome("session-images", "inspect", {
        images: [{ type: "image", data: "png", mimeType: "image/png" }],
        steeringAuthorizationAffinity: TEST_STEERING_AUTHORIZATION_AFFINITY,
      }).queued,
    ).toBe(true);
    expect(queueMessage).toHaveBeenCalledWith("inspect", {
      images: [{ type: "image", data: "png", mimeType: "image/png" }],
      steeringAuthorizationAffinity: TEST_STEERING_AUTHORIZATION_AFFINITY,
    });
  });

  it("authorizes active-run aborts by exact controller affinity", () => {
    const abort = vi.fn();
    const createAffinity = (connectionId: string) =>
      createSteeringAuthorizationAffinity({
        turnAuthority: createOperatorTurnAuthoritySnapshot({
          scopes: ["operator.write"],
          connectionId,
          agentId: "main",
          sessionKey: "agent:main:main",
          conversationId: "agent:main:main",
          trigger: "test",
          capability: "same-capability",
        }),
      });
    const ownerAffinity = createAffinity("owner");
    setActiveEmbeddedRun(
      "session-authorized-abort",
      createRunHandle({ abort, steeringAuthorizationAffinity: ownerAffinity }),
    );

    expect(
      abortActiveRunWithSteeringAuthorization({
        sessionId: "session-authorized-abort",
        steeringAuthorizationAffinity: createAffinity("other-maintainer"),
        policy: "exact",
      }),
    ).toEqual({ status: "unauthorized", replacementObserved: false });
    expect(abort).not.toHaveBeenCalled();

    expect(
      abortActiveRunWithSteeringAuthorization({
        sessionId: "session-authorized-abort",
        steeringAuthorizationAffinity: ownerAffinity,
        policy: "exact",
      }),
    ).toEqual({
      status: "aborted",
      replacementObserved: false,
      controlledAuthorizationAffinity: ownerAffinity,
    });
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("allows admin control but preserves a synchronous replacement", () => {
    const replacementAbort = vi.fn();
    const replacement = createRunHandle({ abort: replacementAbort });
    const ownerAffinity = createSteeringAuthorizationAffinity({
      turnAuthority: createOperatorTurnAuthoritySnapshot({
        scopes: ["operator.write"],
        connectionId: "owner",
        agentId: "main",
        sessionKey: "agent:main:main",
        conversationId: "agent:main:main",
        trigger: "test",
      }),
    });
    const adminAffinity = createSteeringAuthorizationAffinity({
      turnAuthority: createOperatorTurnAuthoritySnapshot({
        scopes: ["operator.admin"],
        connectionId: "admin",
        agentId: "main",
        sessionKey: "agent:main:main",
        conversationId: "agent:main:main",
        trigger: "test",
      }),
    });
    setActiveEmbeddedRun(
      "session-replacement-abort",
      createRunHandle({
        steeringAuthorizationAffinity: ownerAffinity,
        abort: () => setActiveEmbeddedRun("session-replacement-abort", replacement),
      }),
    );

    expect(
      abortActiveRunWithSteeringAuthorization({
        sessionId: "session-replacement-abort",
        steeringAuthorizationAffinity: adminAffinity,
        policy: "operator-owner-or-admin",
      }),
    ).toEqual({
      status: "aborted",
      replacementObserved: true,
      controlledAuthorizationAffinity: ownerAffinity,
    });
    expect(replacementAbort).not.toHaveBeenCalled();
  });

  it("rejects active-run injection when sender authorization affinity differs", async () => {
    const queueMessage = vi.fn(async () => {});
    const ownerAffinity = createSteeringAuthorizationAffinity({
      turnAuthority: createTurnAuthoritySnapshot({
        principal: {
          kind: "sender",
          provider: "discord",
          accountId: "molty",
          senderId: "owner-user",
          senderIsOwner: true,
          isAuthorizedSender: true,
          roleIds: ["maintainers"],
        },
        agentId: "molty",
        sessionKey: "agent:molty:discord:channel:maintenance",
        conversationId: "maintenance",
        controllerKey: "sender:discord:molty:owner-user",
      }),
    });
    const maintainerAffinity = createSteeringAuthorizationAffinity({
      turnAuthority: createTurnAuthoritySnapshot({
        principal: {
          kind: "sender",
          provider: "discord",
          accountId: "molty",
          senderId: "maintainer",
          senderIsOwner: false,
          isAuthorizedSender: true,
          roleIds: ["maintainers"],
        },
        agentId: "molty",
        sessionKey: "agent:molty:discord:channel:maintenance",
        conversationId: "maintenance",
        controllerKey: "sender:discord:molty:maintainer",
      }),
    });
    setActiveEmbeddedRun(
      "session-owner",
      createRunHandle({ queueMessage, steeringAuthorizationAffinity: ownerAffinity }),
    );

    const outcome = await queueEmbeddedAgentMessageWithOutcomeAsync(
      "session-owner",
      "run a maintainer task",
      {
        steeringMode: "all",
        isInboundUserMessage: true,
        steeringAuthorizationAffinity: maintainerAffinity,
      },
    );

    expect(outcome).toEqual({
      queued: false,
      sessionId: "session-owner",
      reason: "authorization_affinity_mismatch",
      gatewayHealth: "live",
    });
    expect(queueMessage).not.toHaveBeenCalled();
  });

  it("rejects direct unmarked injection into attributed and legacy handles", () => {
    const attributedQueue = vi.fn(async () => {});
    const legacyQueue = vi.fn(async () => {});
    setActiveEmbeddedRun(
      "session-attributed-unmarked",
      createSteerableRunHandle({ queueMessage: attributedQueue }),
    );
    setActiveEmbeddedRun("session-legacy-unmarked", createRunHandle({ queueMessage: legacyQueue }));

    expect(
      queueEmbeddedAgentMessageWithOutcome("session-attributed-unmarked", "continue"),
    ).toMatchObject({ queued: false, reason: "authorization_affinity_mismatch" });
    expect(
      queueEmbeddedAgentMessageWithOutcome("session-legacy-unmarked", "continue"),
    ).toMatchObject({ queued: false, reason: "authorization_affinity_mismatch" });
    expect(attributedQueue).not.toHaveBeenCalled();
    expect(legacyQueue).not.toHaveBeenCalled();
  });

  it("keeps the trusted harness path bound to an exact native handle", () => {
    const queueMessage = vi.fn(async () => {});
    const operation = createReplyOperation({
      sessionKey: "agent:main:harness-no-native-handle",
      sessionId: "session-harness-no-native-handle",
      resetTriggered: false,
    });
    operation.attachBackend({
      kind: "embedded",
      cancel: vi.fn(),
      isStreaming: () => true,
      queueMessage,
    });
    operation.setPhase("running");

    expect(
      queueEmbeddedAgentHarnessMessageWithOutcome("session-harness-no-native-handle", "continue"),
    ).toEqual({
      queued: false,
      sessionId: "session-harness-no-native-handle",
      reason: "no_active_run",
      gatewayHealth: "live",
    });
    expect(queueMessage).not.toHaveBeenCalled();
  });

  it("rejects a structurally matching affinity that core did not issue", () => {
    const queueMessage = vi.fn(async () => {});
    const forgedAffinity = structuredClone(
      TEST_STEERING_AUTHORIZATION_AFFINITY,
    ) as SteeringAuthorizationAffinity;
    setActiveEmbeddedRun("session-forged-affinity", createSteerableRunHandle({ queueMessage }));

    expect(
      queueEmbeddedAgentMessageWithOutcome("session-forged-affinity", "continue", {
        steeringAuthorizationAffinity: forgedAffinity,
      }),
    ).toMatchObject({ queued: false, reason: "authorization_affinity_mismatch" });
    expect(queueMessage).not.toHaveBeenCalled();
  });

  it("accepts active-run injection only with the exact frozen affinity", async () => {
    const queueMessage = vi.fn(async () => {});
    const affinity = createSteeringAuthorizationAffinity({
      turnAuthority: createTurnAuthoritySnapshot({
        principal: {
          kind: "sender",
          provider: "Discord",
          accountId: "molty",
          senderId: "maintainer",
          senderIsOwner: false,
          isAuthorizedSender: true,
          roleIds: ["writers", "maintainers", "writers"],
        },
        agentId: "molty",
        sessionKey: "agent:molty:discord:channel:maintenance",
        conversationId: "thread-1",
        parentConversationId: "maintenance",
        threadId: "thread-1",
        controllerKey: "sender:discord:molty:maintainer",
      }),
    });
    setActiveEmbeddedRun(
      "session-maintainer",
      createRunHandle({ queueMessage, steeringAuthorizationAffinity: affinity }),
    );

    const outcome = await queueEmbeddedAgentMessageWithOutcomeAsync(
      "session-maintainer",
      "continue",
      { steeringAuthorizationAffinity: affinity },
    );

    expect(outcome.queued).toBe(true);
    expect(queueMessage).toHaveBeenCalledWith("continue", {
      steeringAuthorizationAffinity: affinity,
    });
  });

  it("queues a captured internal handoff only into its exact active attempt", async () => {
    const queueMessage = vi.fn(async () => {});
    const handle = createRunHandle({
      runId: "run-parent",
      queueMessage,
      steeringAuthorizationAffinity: TEST_STEERING_AUTHORIZATION_AFFINITY,
    });
    setActiveEmbeddedRun("session-parent", handle);

    const target = captureActiveEmbeddedRunSteeringTarget({
      sessionId: "session-parent",
      runId: "run-parent",
      steeringAuthorizationAffinity: TEST_STEERING_AUTHORIZATION_AFFINITY,
    });
    expect(target).toBeDefined();

    const outcome = await target!.queueMessageWithOutcome("child completed", {
      steeringMode: "all",
      waitForTranscriptCommit: false,
    });

    expect(outcome.queued).toBe(true);
    expect(queueMessage).toHaveBeenCalledWith("child completed", {
      steeringMode: "all",
      waitForTranscriptCommit: false,
      steeringAuthorizationAffinity: TEST_STEERING_AUTHORIZATION_AFFINITY,
    });
  });

  it("does not mint a parent handoff capability for different authority or run ID", () => {
    const queueMessage = vi.fn(async () => {});
    const differentAuthority = createSteeringAuthorizationAffinity({
      turnAuthority: createTurnAuthoritySnapshot({
        principal: { kind: "service", serviceId: "other-controller" },
        agentId: "main",
        sessionKey: "agent:main:main",
        conversationId: "agent:main:main",
        controllerKey: "service:other-controller",
      }),
    });
    setActiveEmbeddedRun(
      "session-parent",
      createRunHandle({
        runId: "run-parent",
        queueMessage,
        steeringAuthorizationAffinity: TEST_STEERING_AUTHORIZATION_AFFINITY,
      }),
    );

    expect(
      captureActiveEmbeddedRunSteeringTarget({
        sessionId: "session-parent",
        runId: "run-parent",
        steeringAuthorizationAffinity: differentAuthority,
      }),
    ).toBeUndefined();
    expect(
      captureActiveEmbeddedRunSteeringTarget({
        sessionId: "session-parent",
        runId: "run-replaced",
        steeringAuthorizationAffinity: TEST_STEERING_AUTHORIZATION_AFFINITY,
      }),
    ).toBeUndefined();
    expect(queueMessage).not.toHaveBeenCalled();
  });

  it("invalidates a captured handoff when the parent attempt is replaced", async () => {
    const oldQueue = vi.fn(async () => {});
    const replacementQueue = vi.fn(async () => {});
    const oldHandle = createRunHandle({
      runId: "run-parent",
      queueMessage: oldQueue,
      steeringAuthorizationAffinity: TEST_STEERING_AUTHORIZATION_AFFINITY,
    });
    setActiveEmbeddedRun("session-parent", oldHandle);
    const target = captureActiveEmbeddedRunSteeringTarget({
      sessionId: "session-parent",
      runId: "run-parent",
      steeringAuthorizationAffinity: TEST_STEERING_AUTHORIZATION_AFFINITY,
    });
    expect(target).toBeDefined();

    setActiveEmbeddedRun(
      "session-parent",
      createRunHandle({
        runId: "run-parent",
        queueMessage: replacementQueue,
        steeringAuthorizationAffinity: TEST_STEERING_AUTHORIZATION_AFFINITY,
      }),
    );
    await expect(target!.queueMessageWithOutcome("child completed")).resolves.toMatchObject({
      queued: false,
      reason: "no_active_run",
    });
    expect(oldQueue).not.toHaveBeenCalled();
    expect(replacementQueue).not.toHaveBeenCalled();
  });
});
