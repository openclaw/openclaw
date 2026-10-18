// Subagent announce delivery tests cover the last-mile routing used when child
// runs report progress or completion back to the requester session.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateAgentParams } from "../../../../packages/gateway-protocol/src/index.js";
import { formatValidationErrors } from "../../../../packages/gateway-protocol/src/validation-errors.js";
import { awaitGateBeforeSettlement } from "../../../../test/helpers/promise.js";
import type { SessionEntry } from "../../../config/sessions.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { InternalAgentTurnDispatchOptions } from "../../../gateway/agent-turn/internal-facade.types.js";
import type { callGateway as runtimeCallGateway } from "../../../gateway/call.js";
import { authorizeGatewaySessionCreation } from "../../../gateway/operator-role-policy.js";
import { waitForGatewayDispatch } from "../../../gateway/server-in-process-dispatch.js";
import type { dispatchGatewayMethodInProcess as runtimeDispatchGatewayMethodInProcess } from "../../../gateway/server-plugins.js";
import {
  OutboundDeliveryError,
  PlatformMessageNotDispatchedError,
} from "../../../infra/outbound/deliver-types.js";
import { sendMessage as runtimeSendMessage } from "../../../infra/outbound/message.js";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import { withSessionTurn } from "../../../sessions/session-controller.admission.js";
import { captureSessionTarget } from "../../../sessions/session-controller.lifecycle.js";
import {
  reserveSessionControllerSource,
  retireSessionControllerInput,
} from "../../../sessions/session-controller.mailbox.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../../test-utils/channel-plugins.js";
import type { AgentInternalEvent } from "../../internal-events.js";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
} from "../../internal-runtime-context.js";
import {
  expectDeliveryPath,
  expectRecordFields,
  imageCompletionEvents,
  mockCallArg,
  musicCompletionEvents,
  taskCompletionEvents,
} from "../../subagent-test-fixtures.test-helpers.js";
import {
  testing,
  deliverSubagentAnnouncement,
  loadRequesterSessionEntry,
  registerDescendantWakeCurrencyTests,
} from "./subagent-announce-delivery.test-support.js";
import { runDescendantWake } from "./subagent-announce-descendant-wake.js";
import type { SubagentAnnounceDeliveryTestDeps } from "./subagent-announce-overrides.test-support.js";
import { privateCompletionCases } from "./subagent-announce-private-completion.test-fixtures.js";
import { createRequesterSettleCases } from "./subagent-announce-requester-settle.test-fixtures.js";

const sessionDeliveryQueueMocks = vi.hoisted(() => ({
  enqueueClaimedSessionDelivery: vi.fn(
    (_payload: unknown, _leaseMs: number, _queueContext: OpenClawStateWorkerContext) => ({
      id: "session-delivery-media",
      claimed: true,
      status: "pending" as "pending" | "failed" | "completed" | "unknown",
    }),
  ),
  releaseSessionDeliveryClaim: vi.fn(async () => {}),
  scheduleSessionDelivery: vi.fn(async () => true),
}));

let fixtureQueueContext: OpenClawStateWorkerContext;

beforeEach(() => {
  fixtureQueueContext = captureOpenClawStateWorkerContext();
});

function expectQueueContext() {
  const queuedContext =
    sessionDeliveryQueueMocks.enqueueClaimedSessionDelivery.mock.calls.at(-1)?.[2];
  if (!queuedContext) {
    throw new Error("Expected the durable handoff to capture its queue context");
  }
  return expect.objectContaining({
    environment: fixtureQueueContext.environment,
    admission: expect.objectContaining({
      databasePath: fixtureQueueContext.admission.databasePath,
      identity: queuedContext.admission.identity,
    }),
  });
}

vi.mock("../completion/subagent-completion-delivery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../completion/subagent-completion-delivery.js")>()),
  admitCorrelatedSubagentSessionDelivery: (params: { payload: Record<string, unknown> }) =>
    sessionDeliveryQueueMocks.enqueueClaimedSessionDelivery(
      params.payload,
      125_000,
      captureOpenClawStateWorkerContext(),
    ),
}));

vi.mock("../../../infra/session-delivery-queue-storage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../infra/session-delivery-queue-storage.js")>()),
  enqueueClaimedSessionDelivery: async (
    ...args: Parameters<typeof sessionDeliveryQueueMocks.enqueueClaimedSessionDelivery>
  ) => sessionDeliveryQueueMocks.enqueueClaimedSessionDelivery(...args),
  releaseSessionDeliveryClaim: sessionDeliveryQueueMocks.releaseSessionDeliveryClaim,
}));

vi.mock("../../../infra/session-delivery-queue-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../infra/session-delivery-queue-runtime.js")>()),
  scheduleSessionDelivery: sessionDeliveryQueueMocks.scheduleSessionDelivery,
}));

afterEach(() => {
  vi.useRealTimers();
  setActivePluginRegistry(createTestRegistry());
  testing.setDepsForTest();
  sessionDeliveryQueueMocks.enqueueClaimedSessionDelivery.mockClear();
  sessionDeliveryQueueMocks.releaseSessionDeliveryClaim.mockClear();
  sessionDeliveryQueueMocks.scheduleSessionDelivery.mockClear();
});

function requesterActivity(
  sessionId: string | undefined,
  isActive: boolean,
): SubagentAnnounceDeliveryTestDeps["getRequesterSessionActivity"] {
  return (sessionKey, requester) => ({
    sessionId,
    isActive,
    target: captureSessionTarget({
      storeScope: requester.storePath ?? "/synthetic/announce-delivery/sessions.json",
      sessionKey: requester.canonicalKey,
      aliases: [sessionKey],
      agentId: requester.agentId,
      incarnation: sessionId,
    }),
  });
}

function deliverAnnouncement(
  params: Pick<AnnouncementInput, "requesterSessionKey" | "directIdempotencyKey"> &
    Partial<AnnouncementInput>,
) {
  return deliverSubagentAnnouncement({
    targetRequesterSessionKey: params.requesterSessionKey,
    triggerMessage: "child done",
    requesterIsSubagent: false,
    expectsCompletionMessage: true,
    ...params,
  });
}

describe("queued completion handoff", () => {
  it.each(["source retired", "post-start expiry", "delivery deadline", "private"] as const)(
    "keeps an accepted busy-parent completion pending until execution: %s",
    async (outcome) => {
      vi.useFakeTimers();
      const accepted = createDeferredCore<InternalAgentTurnDispatchOptions>();
      const parentSettled = createDeferredCore();
      const executionSettled = createDeferredCore();
      const executionStarted = createDeferredCore();
      const deliveryDeadline = new AbortController();
      const expiryTimer =
        outcome === "post-start expiry"
          ? setTimeout(
              () => deliveryDeadline.abort(new Error("completion delivery expired")),
              180_000,
            )
          : undefined;
      let sourceAllowed = true;
      let executed = false;
      const dispatchGatewayMethodInProcess: typeof runtimeDispatchGatewayMethodInProcess = async <
        T,
      >(
        _method: string,
        _params: Record<string, unknown>,
        options?: InternalAgentTurnDispatchOptions,
      ) => {
        options?.onAccepted?.({ status: "accepted", runId: "completion-run" });
        accepted.resolve(options ?? {});
        const operation = parentSettled.promise.then(async () => {
          options?.onExecutionStarted?.();
          executed = true;
          executionStarted.resolve();
          await executionSettled.promise;
          return {
            status: "ok",
            ...(outcome === "private" ? { inputProcessingCompleted: true } : {}),
            result: {
              payloads: outcome === "private" ? [] : [{ text: "Parent received child result" }],
              meta: {
                terminalReply:
                  outcome === "private"
                    ? { disposition: "silent" }
                    : { disposition: "visible", text: "Parent received child result" },
              },
            },
          } as T;
        });
        return await waitForGatewayDispatch(
          "agent",
          operation,
          options?.timeoutMs,
          options?.signal,
        );
      };
      testing.setDepsForTest({
        dispatchGatewayMethodInProcess,
        getRuntimeConfig: () => ({}),
        getRequesterSessionActivity: requesterActivity("busy-parent", true),
      });
      let finished = false;
      const delivery = deliverAnnouncement({
        requesterSessionKey: "agent:main:subagent:parent",
        requesterIsSubagent: true,
        triggerMessage: "Child result ready",
        directIdempotencyKey: "busy-parent-completion",
        ...(outcome === "private"
          ? { completionTarget: "parent" as const, completionRequesterSessionId: "busy-parent" }
          : {}),
        isSourceSessionEffectsAllowed: () => sourceAllowed,
        signal: deliveryDeadline.signal,
        onExecutionStarted: () => clearTimeout(expiryTimer),
      }).finally(() => {
        finished = true;
      });
      try {
        await accepted.promise;
        await vi.advanceTimersByTimeAsync(120_001);
        expect(finished).toBe(false);
        expect(executed).toBe(false);
        if (outcome === "delivery deadline") {
          deliveryDeadline.abort(new Error("completion delivery expired"));
          expect(await delivery).toMatchObject({ delivered: false, path: "none" });
          parentSettled.resolve();
          await vi.advanceTimersByTimeAsync(0);
          expect(executed).toBe(false);
          return;
        }
        sourceAllowed = outcome !== "source retired";
        parentSettled.resolve();
        if (outcome === "post-start expiry") {
          await executionStarted.promise;
          await vi.advanceTimersByTimeAsync(120_001);
          expect(finished).toBe(false);
          expect((await accepted.promise).signal?.aborted).toBe(false);
        }
        executionSettled.resolve();
        const result = await delivery;
        expect(result).toMatchObject(
          sourceAllowed
            ? { delivered: true, path: "direct" }
            : { delivered: false, reason: "source_owner_changed" },
        );
        if (sourceAllowed) {
          expect(result.phases).toEqual([
            expect.objectContaining({ phase: "direct-primary", delivered: true, path: "direct" }),
          ]);
        }
        expect(executed).toBe(sourceAllowed);
      } finally {
        clearTimeout(expiryTimer);
        parentSettled.resolve();
        executionSettled.resolve();
        await delivery;
      }
    },
  );
});

const slackThreadOrigin = {
  channel: "slack",
  to: "channel:C123",
  accountId: "acct-1",
  threadId: "171.222",
} as const;

const sentDeliveryStatus = { status: "sent", resultCount: 1 } as const;

function createGatewayMock(response: Record<string, unknown> | Error = {}, onCall?: () => void) {
  return vi.fn(async (opts: Parameters<typeof runtimeCallGateway>[0]) => {
    onCall?.();
    if (response instanceof Error) {
      throw response;
    }
    opts.onAccepted?.({ status: "accepted" });
    return response;
  }) as unknown as typeof runtimeCallGateway;
}

function createPayloadGatewayMock(...payloads: Record<string, unknown>[]) {
  return createGatewayMock({
    result: { payloads, ...(payloads.length > 0 ? { deliveryStatus: sentDeliveryStatus } : {}) },
  });
}

function createInProcessGatewayMock(response: Record<string, unknown> = {}) {
  return vi.fn(async () => response) as unknown as typeof runtimeDispatchGatewayMethodInProcess;
}

function createRoleRestrictedInProcessGatewayMock(response: Record<string, unknown>) {
  const cfg = {
    gateway: {
      roles: {
        default: "restricted",
        definitions: {
          restricted: {
            agents: [],
            scopes: ["operator.write"],
            sessions: { others: "none" },
          },
        },
      },
    },
  } satisfies OpenClawConfig;
  const dispatchGatewayMethodInProcess = vi.fn(
    async (
      _method: string,
      _agentParams: Record<string, unknown>,
      options?: Parameters<typeof runtimeDispatchGatewayMethodInProcess>[2],
    ) => {
      const actor = options?.operatorRoleActor;
      const authorizationError = actor
        ? authorizeGatewaySessionCreation({ cfg, agentId: "main", actor })
        : authorizeGatewaySessionCreation({ cfg, agentId: "main", profileId: undefined });
      if (authorizationError) {
        throw new Error(`${authorizationError.code}: ${authorizationError.message}`);
      }
      return response;
    },
  ) as unknown as typeof runtimeDispatchGatewayMethodInProcess;
  return { cfg, dispatchGatewayMethodInProcess };
}

function createSendMessageMock() {
  return vi.fn(async () => ({
    channel: "slack",
    to: "channel:C123",
    via: "direct" as const,
    mediaUrl: null,
    result: { messageId: "msg-1" },
  })) as unknown as typeof runtimeSendMessage;
}

const committedSessionSpawnEvidence = {
  acceptedSessionSpawns: [{ runId: "run-child", childSessionKey: "agent:main:child" }],
} as const;

function registerDirectTargetTestChannel(channelId: string): void {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: channelId,
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({
            id: channelId,
            capabilities: { chatTypes: ["direct", "channel"] },
          }),
          messaging: {
            inferTargetChatType: ({ to }: { to: string }) =>
              to.startsWith("channel:") || to.startsWith("thread:") ? "channel" : "direct",
          },
        },
      },
    ]),
  );
}

function expectGatewayAgentParams(
  callGateway: typeof runtimeCallGateway,
  expected: Record<string, unknown>,
) {
  const request = expectRecordFields(mockCallArg(callGateway), { method: "agent" });
  return expectRecordFields(request.params, expected);
}

function expectInProcessAgentParams(
  dispatchGatewayMethodInProcess: typeof runtimeDispatchGatewayMethodInProcess,
  expected: Record<string, unknown>,
) {
  const method = mockCallArg(dispatchGatewayMethodInProcess, 0, 0);
  expect(method).toBe("agent");
  const params = mockCallArg(dispatchGatewayMethodInProcess, 0, 1);
  return expectRecordFields(params, expected);
}

type AnnouncementInput = Parameters<typeof deliverSubagentAnnouncement>[0];
type DeliveryFixtureParams = Partial<AnnouncementInput> & {
  callGateway: typeof runtimeCallGateway;
  sendMessage?: typeof runtimeSendMessage;
  runtimeConfig?: OpenClawConfig;
  isActive?: boolean;
  sessionId?: string;
  currentRequesterSessionId?: string | null;
  requesterAbandonment?: "timeout" | "recovering_timeout";
  origin?: AnnouncementInput["directOrigin"];
  requesterOrigin?: AnnouncementInput["directOrigin"];
  requesterSessionEntry?: SessionEntry;
  requesterSessionActivity?: SubagentAnnounceDeliveryTestDeps["getRequesterSessionActivity"];
};
const deliveryRoutes = {
  thread: {
    key: "agent:main:slack:channel:C123:thread:171.222",
    sessionId: "requester-session-4",
    origin: slackThreadOrigin,
    id: "announce-thread",
  },
  channel: {
    key: "agent:main:slack:channel:C123",
    sessionId: "requester-session-channel",
    origin: { channel: "slack", to: "channel:C123", accountId: "acct-1" },
    id: "announce-channel",
  },
  discord: {
    key: "agent:main:discord:dm:U123",
    sessionId: "requester-session-dm",
    origin: { channel: "discord", to: "dm:U123", accountId: "acct-1" },
    id: "announce-dm-fallback-empty",
  },
  telegram: {
    key: "agent:main:telegram:123456789",
    sessionId: "requester-session-telegram",
    origin: { channel: "telegram", to: "123456789", accountId: "bot-1" },
    id: "announce-telegram-dm-fallback",
  },
};
async function deliverFixture(
  routeName: keyof typeof deliveryRoutes,
  params: DeliveryFixtureParams,
) {
  const {
    callGateway,
    sendMessage = runtimeSendMessage,
    runtimeConfig: cfg = {},
    isActive,
    sessionId,
    currentRequesterSessionId,
    requesterAbandonment,
    origin: explicitOrigin,
    requesterOrigin,
    requesterSessionEntry,
    requesterSessionActivity,
    ...delivery
  } = params;
  const route = deliveryRoutes[routeName];
  const origin = explicitOrigin ?? requesterOrigin ?? route.origin;
  const requesterSessionKey = delivery.requesterSessionKey ?? route.key;
  testing.setDepsForTest({
    callGateway,
    sendMessage,
    getRuntimeConfig: () => cfg,
    getRequesterSessionActivity:
      requesterSessionActivity ??
      requesterActivity(
        currentRequesterSessionId === null
          ? undefined
          : (currentRequesterSessionId ?? sessionId ?? route.sessionId),
        isActive === true,
      ),
    ...(routeName === "thread" || routeName === "telegram"
      ? {
          resolveRequesterSessionAbandonment: () => requesterAbandonment,
        }
      : {}),
    ...(requesterSessionEntry
      ? {
          loadRequesterSessionEntry: (canonicalKey: string) => ({
            cfg,
            canonicalKey,
            entry: requesterSessionEntry,
          }),
        }
      : {}),
  });
  return deliverAnnouncement({
    ...delivery,
    requesterSessionKey,
    targetRequesterSessionKey: requesterSessionKey,
    directOrigin: origin,
    requesterSessionOrigin: origin,
    completionDirectOrigin: delivery.completionDirectOrigin ?? origin,
    requesterIsSubagent: delivery.requesterIsSubagent === true,
    expectsCompletionMessage: delivery.expectsCompletionMessage !== false,
    bestEffortDeliver: true,
    sourceRunId: "run-generated-media",
    directIdempotencyKey: delivery.directIdempotencyKey ?? route.id,
    ...(delivery.completionTarget ? { completionRequesterSessionId: "requester-session-dm" } : {}),
  });
}
const deliverSlackThreadAnnouncement = (params: DeliveryFixtureParams) =>
  deliverFixture("thread", params);
const deliverSlackChannelAnnouncement = (params: DeliveryFixtureParams) =>
  deliverFixture("channel", params);
const deliverDiscordDirectMessageCompletion = (params: DeliveryFixtureParams) =>
  deliverFixture("discord", params);
const deliverTelegramDirectMessageCompletion = (params: DeliveryFixtureParams) =>
  deliverFixture("telegram", params);

describe("deliverSubagentAnnouncement requester resolution", () => {
  const sharedStore = "/stores/shared.sqlite";
  const configuredAgents: NonNullable<OpenClawConfig["agents"]> = {
    ownership: "explicit",
    entries: { ops: {}, research: {} },
  };
  function announce(overrides: Partial<AnnouncementInput> = {}) {
    const requesterSessionKey = overrides.requesterSessionKey ?? "agent:eng:paperclip:issue:123";
    return deliverAnnouncement({
      requesterSessionKey,
      targetRequesterSessionKey: requesterSessionKey,
      expectsCompletionMessage: false,
      directIdempotencyKey: "announce-no-external-route",
      ...overrides,
    });
  }

  it("loads a custom main alias through its canonical requester key", async () => {
    const loadSessionEntry = vi.fn(() => ({ sessionId: "research-main", updatedAt: 1 }));
    testing.setDepsForTest({
      getRuntimeConfig: () => ({
        session: { mainKey: "work", store: sharedStore },
        agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
      }),
      loadSessionEntry,
    });
    expect(await loadRequesterSessionEntry("work", "research")).toMatchObject({
      canonicalKey: "agent:research:work",
      entry: { sessionId: "research-main" },
    });
    expect(loadSessionEntry).toHaveBeenCalledWith({
      agentId: "research",
      clone: false,
      sessionKey: "agent:research:work",
      storePath: sharedStore,
    });
  });

  it.each<[name: string, storeOwner?: string, requesterAgentId?: string]>([
    ["fails closed for a restored bare requester key without an owner"],
    [
      "rejects a restored bare requester whose explicit agent conflicts with the store owner",
      "ops",
      "research",
    ],
    ["fails closed for a restored bare requester key with a retired store owner", "retired"],
  ])("%s", async (_name, storeOwner, requesterAgentId) => {
    const cfg: OpenClawConfig = {
      session: { scope: "global", ...(storeOwner ? { store: sharedStore } : {}) },
      agents: {
        ...configuredAgents,
        ...(storeOwner ? { defaults: { sessionStore: { agentId: storeOwner } } } : {}),
      },
    };
    const isSessionRunActive = vi.fn(() => true);
    const loadSessionEntry = vi.fn(() => ({ sessionId: "ops-session", updatedAt: 1 }));
    testing.setDepsForTest({
      getRuntimeConfig: () => cfg,
      isSessionRunActive,
      loadSessionEntry,
      callGateway: vi.fn(async () => {
        throw new Error("requester owner unavailable");
      }),
    });
    const result = await announce({ requesterSessionKey: "global", requesterAgentId });
    expect(result.delivered).toBe(false);
    expect(isSessionRunActive).not.toHaveBeenCalled();
    expect(loadSessionEntry).not.toHaveBeenCalled();
  });
});

describe("deliverSubagentAnnouncement completion delivery", () => {
  it.each([true])(
    "defers completion delivery when sessions_yield owns the handoff (active: %s)",
    async (isActive) => {
      const callGateway = createGatewayMock();

      const result = await deliverSlackThreadAnnouncement({
        callGateway,
        sessionId: "requester-session-1",
        isActive,
        directIdempotencyKey: `announce-yield-owned-completion-${isActive}`,
        isCompletionOwnedByRequesterYield: () => true,
      });

      expect(result).toMatchObject({
        delivered: false,
        path: "none",
        reason: "completion_handoff_pending",
        terminal: true,
        disposition: "intentional_non_delivery",
      });
      expect(callGateway).not.toHaveBeenCalled();
    },
  );

  it("delivers the child result when requester synthesis omits it", async () => {
    const childResult = "The child found the root cause.";
    const callGateway = createGatewayMock({
      result: { payloads: [{ text: "TG88042_NO_REOUTPUT" }] },
    });
    const sendMessage = createSendMessageMock();
    const result = await deliverDiscordDirectMessageCompletion({
      callGateway,
      sendMessage,
      internalEvents: taskCompletionEvents({
        childSessionId: "child-session-id",
        result: childResult,
      }),
    });
    expectDeliveryPath(result, "direct");
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        accountId: "acct-1",
        to: "dm:U123",
        content: childResult,
        idempotencyKey: "announce-dm-fallback-empty:text-direct",
      }),
    );
  });

  it.each(privateCompletionCases)(
    "preserves private parent consumption and final evidence: $name",
    async (testCase) => {
      const callGateway = createGatewayMock({
        status: "ok",
        inputProcessingCompleted: true,
        result: testCase.result,
      });
      const sendMessage = createSendMessageMock();
      const delivery = await deliverDiscordDirectMessageCompletion({
        callGateway,
        sendMessage,
        completionTarget: "parent",
        internalEvents: taskCompletionEvents(),
        isActive: true,
        runtimeConfig: { tools: { deny: ["message"] } },
        ...("params" in testCase ? testCase.params : {}),
      });
      expectDeliveryPath(delivery, "direct");
      expect(delivery.requesterVisibleFinalDelivered).toBe(testCase.recordsVisibleFinal);
      expect(delivery).not.toHaveProperty("finalAssistantVisibleText");
      expect(sendMessage).not.toHaveBeenCalled();
      expectGatewayAgentParams(callGateway, {
        deliver: false,
        sourceReplyDeliveryMode: "automatic",
        expectedExistingSessionId: "requester-session-dm",
      });
    },
  );

  it.each([
    {
      name: "accepted",
      response: { status: "accepted", runId: "pending" },
      expected: { path: "direct", reason: "requester_turn_pending", disposition: "session_queued" },
    },
    {
      name: "error",
      response: { status: "error", result: { payloads: [{ text: "failed" }] } },
      expected: { disposition: "retryable" },
    },
    {
      name: "operator cancellation",
      response: { status: "timeout", stopReason: "rpc", summary: "cancelled" },
      expected: { terminal: true, disposition: "intentional_non_delivery" },
    },
  ])("records private handoff $name without raw fallback", async ({ response, expected }) => {
    const sendMessage = createSendMessageMock();
    const delivery = await deliverDiscordDirectMessageCompletion({
      callGateway: createGatewayMock(response),
      sendMessage,
      completionTarget: "parent",
      internalEvents: taskCompletionEvents(),
    });
    expect(delivery).toMatchObject({ delivered: false, ...expected });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each([null, "replacement-parent"])(
    "does not deliver private completion to a missing or replaced parent: %s",
    async (currentRequesterSessionId) => {
      const callGateway = createGatewayMock({ status: "ok", result: { payloads: [] } });
      const sendMessage = createSendMessageMock();
      const result = await deliverDiscordDirectMessageCompletion({
        callGateway,
        sendMessage,
        completionTarget: "parent",
        currentRequesterSessionId,
        internalEvents: taskCompletionEvents(),
      });
      expect(result).toMatchObject({
        delivered: false,
        reason: "completion_handoff_unavailable",
        terminal: true,
      });
      expect(callGateway).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "intentional suppression",
      suppressionReason: "cancelled_by_message_sending_hook",
      disposition: "intentional_non_delivery",
      reason: "delivery_suppressed",
    },
    {
      name: "adapter ambiguity",
      suppressionReason: "adapter_returned_no_identity",
      disposition: "ambiguous",
      reason: undefined,
    },
  ] as const)("reports $name from direct text completion fallback", async (testCase) => {
    const callGateway = createPayloadGatewayMock();
    const onDeliveryResult = vi.fn();
    const sendMessage = vi.fn(async () => ({
      channel: "discord",
      to: "dm:U123",
      via: "direct" as const,
      mediaUrl: null,
      deliveryStatus: "suppressed" as const,
      suppressionReason: testCase.suppressionReason,
    })) as unknown as typeof runtimeSendMessage;

    const result = await deliverDiscordDirectMessageCompletion({
      callGateway,
      sendMessage,
      internalEvents: taskCompletionEvents({ childSessionId: "child-session-id" }),
      onDeliveryResult,
    });

    expectRecordFields(result, {
      delivered: false,
      path: "direct",
      disposition: testCase.disposition,
      reason: testCase.reason,
    });
    expect(onDeliveryResult).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("uses the caller owner for direct completion delivery to a bare requester key", async () => {
    const callGateway = createPayloadGatewayMock();
    const sendMessage = createSendMessageMock();

    const result = await deliverDiscordDirectMessageCompletion({
      callGateway,
      sendMessage,
      requesterSessionKey: "global",
      requesterAgentId: "research",
      runtimeConfig: {
        session: { scope: "global" },
        agents: {
          ownership: "explicit",
          entries: { ops: {}, research: {} },
        },
      },
      internalEvents: taskCompletionEvents({ childSessionId: "child-session-id" }),
    });

    expectDeliveryPath(result, "direct");
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requesterSessionKey: "global",
        agentId: "research",
        mirror: expect.objectContaining({
          sessionKey: "global",
          agentId: "research",
        }),
      }),
    );
  });

  it("sanitizes text while preserving the complete direct completion fallback", async () => {
    const callGateway = createPayloadGatewayMock();
    const sendMessage = createSendMessageMock();
    const leaked = [
      "Visible completion",
      INTERNAL_RUNTIME_CONTEXT_BEGIN,
      "sourceTool: subagent_announce\nsourceId: video_generate:private",
      INTERNAL_RUNTIME_CONTEXT_END,
      "x".repeat(8_000),
    ].join("\n");
    const modelRouteChange = "Model route changed: requested/model → actual/model.";

    await deliverDiscordDirectMessageCompletion({
      callGateway,
      sendMessage,
      internalEvents: taskCompletionEvents({
        childSessionId: "child-session-id",
        result: leaked,
        modelRouteChange,
      }),
    });

    const content = mockCallArg(sendMessage, 0, 0).content;
    if (typeof content !== "string") {
      throw new Error("expected direct completion text");
    }
    expect(content).toContain("Visible completion");
    expect(content).not.toContain("subagent_announce");
    expect(content).not.toContain("video_generate");
    expect(content).not.toContain(modelRouteChange);
    expect(content).toContain("x".repeat(8_000));
  });

  it.each(["cancelled", "source owner changed"] as const)(
    "stops a failed-child notice when %s at platform dispatch",
    async (blockedBy) => {
      const childSessionKey = `agent:worker:subagent:${blockedBy.replaceAll(" ", "-")}`;
      const controller = new AbortController();
      let sourceEffectsAllowed = true;
      const platformSend = vi.fn();
      const callGateway = createGatewayMock(new Error("provider rejected requester synthesis"));
      const sendMessage = vi.fn(async (params: Parameters<typeof runtimeSendMessage>[0]) => {
        expect(params.skipQueue).toBe(true);
        expect(params.abortSignal).toBe(controller.signal);
        if (blockedBy === "cancelled") {
          controller.abort();
        } else {
          sourceEffectsAllowed = false;
        }
        await params.onPlatformSendDispatch?.();
        platformSend();
        return {
          channel: "discord",
          to: "dm:U123",
          via: "direct" as const,
          mediaUrl: null,
          result: { messageId: "msg-after-stale-dispatch" },
        };
      }) as unknown as typeof runtimeSendMessage;

      const result = await deliverDiscordDirectMessageCompletion({
        callGateway,
        sendMessage,
        signal: controller.signal,
        sourceSessionKey: childSessionKey,
        sourceTool: "subagent_announce",
        isSourceSessionEffectsAllowed: () => sourceEffectsAllowed,
        internalEvents: taskCompletionEvents({
          childSessionKey,
          status: "error",
          statusLabel: "failed before fallback dispatch",
          result: "private child output",
        }),
      });

      expect(result).toMatchObject(
        blockedBy === "cancelled"
          ? { delivered: false, path: "none" }
          : { delivered: false, path: "none", reason: "source_owner_changed", terminal: true },
      );
      expect(sendMessage).toHaveBeenCalledOnce();
      expect(platformSend).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      route: "discord",
      sourceSessionKey: "agent:worker:subagent:expected-child",
      childSessionKey: "agent:worker:subagent:other-child",
    },
    {
      route: "thread",
      sourceSessionKey: "agent:worker:subagent:failed-thread-child",
      childSessionKey: "agent:worker:subagent:failed-thread-child",
      directIdempotencyKey: "announce-failed-thread-child",
    },
  ] as const)(
    "does not send a failed-child notice for an untrusted or non-direct $route event",
    async ({ route, childSessionKey, ...options }) => {
      const callGateway = createGatewayMock(new Error("provider rejected requester synthesis"));
      const sendMessage = createSendMessageMock();
      const result = await deliverFixture(route, {
        callGateway,
        sendMessage,
        ...options,
        sourceTool: "subagent_announce",
        internalEvents: taskCompletionEvents({
          childSessionKey,
          status: "error",
          statusLabel: "failed: provider rejected child run",
          result: "private child output",
        }),
      });
      expectRecordFields(result, { delivered: false, path: "direct" });
      expect(sendMessage).not.toHaveBeenCalled();
    },
  );

  it("directly delivers unprefixed direct targets recognized by the channel grammar", async () => {
    registerDirectTargetTestChannel("qa-channel");
    const callGateway = createPayloadGatewayMock();
    const sendMessage = createSendMessageMock();

    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      sendMessage,
      sessionId: "requester-session-qa",
      directIdempotencyKey: "announce-qa-fallback-empty",
      requesterSessionKey: "agent:qa:subagent-direct-fallback:1234",
      requesterOrigin: {
        channel: "qa-channel",
        to: "qa-operator",
        accountId: "default",
      },
      internalEvents: taskCompletionEvents({
        childSessionId: "child-session-id",
        taskLabel: "qa direct completion smoke",
      }),
    });

    expectDeliveryPath(result, "direct");
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "qa-channel",
        accountId: "default",
        to: "qa-operator",
        content: "child completion output",
        idempotencyKey: "announce-qa-fallback-empty:text-direct",
      }),
    );
  });

  it("does not raw-send channel completions just because the requester key is direct", async () => {
    const callGateway = createPayloadGatewayMock();
    const sendMessage = createSendMessageMock();

    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      sendMessage,
      directIdempotencyKey: "announce-channel-direct-key-empty",
      requesterSessionKey: "agent:main:discord:dm:U123",
      internalEvents: taskCompletionEvents({
        childSessionId: "child-session-id",
        taskLabel: "channel completion smoke",
      }),
    });

    expect(result).toMatchObject({
      delivered: false,
      path: "direct",
      reason: "visible_reply_missing",
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("delivers dormant child completion under restrictive gateway roles with Gateway-owned timeout policy", async () => {
    const callGateway = createGatewayMock();
    const { cfg, dispatchGatewayMethodInProcess } = createRoleRestrictedInProcessGatewayMock({
      result: {
        deliveryStatus: sentDeliveryStatus,
        payloads: [{ text: "requester voice completion" }],
        meta: { finalAssistantVisibleText: "requester voice completion" },
      },
    });
    testing.setDepsForTest({
      callGateway,
      dispatchGatewayMethodInProcess,
      getRequesterSessionActivity: requesterActivity("requester-session-local", false),
      getRuntimeConfig: () => cfg,
    });

    const ownerContext = { owner: "gateway-a" } as never;
    const resolveGatewayContext = () => ownerContext;
    const signal = new AbortController().signal;
    const result = await deliverAnnouncement({
      requesterSessionKey: "agent:main:slack:channel:C123:thread:171.222",
      requesterSessionOrigin: slackThreadOrigin,
      completionDirectOrigin: slackThreadOrigin,
      directOrigin: slackThreadOrigin,
      sourceSessionKey: "agent:main:subagent:child",
      internalEvents: taskCompletionEvents({
        childSessionKey: "agent:main:subagent:child",
        childSessionId: "child-session-local",
      }),
      bestEffortDeliver: true,
      directIdempotencyKey: "announce-local-dispatch",
      resolveGatewayContext,
      signal,
    });

    expectDeliveryPath(result, "direct");
    expect(result).toMatchObject({
      requesterVisibleFinalDelivered: true,
      finalAssistantVisibleText: "requester voice completion",
    });
    expect(callGateway).not.toHaveBeenCalled();
    expectInProcessAgentParams(dispatchGatewayMethodInProcess, {
      deliver: true,
      channel: "slack",
      accountId: "acct-1",
      to: "channel:C123",
      threadId: "171.222",
      bestEffortDeliver: true,
    });
    expect(mockCallArg(dispatchGatewayMethodInProcess, 0, 1)).not.toHaveProperty("timeout");
    const dispatchOptions = mockCallArg(dispatchGatewayMethodInProcess, 0, 2);
    expect(dispatchOptions).toMatchObject({
      cancelOnDeadline: true,
      expectFinal: true,
      forceSyntheticClient: true,
      operatorRoleActor: { kind: "system" },
      delegatedToolPolicyHandoff: {
        sourceSessionKey: "agent:main:subagent:child",
        sourceSessionId: "child-session-local",
        targetSessionKey: "agent:main:slack:channel:C123:thread:171.222",
        targetSessionId: "requester-session-local",
        idempotencyKey: "announce-local-dispatch",
      },
      resolveGatewayContext,
      signal: expect.any(AbortSignal),
    });
  });

  registerDescendantWakeCurrencyTests({
    createRoleRestrictedInProcessGatewayMock,
    createGatewayMock,
    runDescendantWake,
  });

  it.each([
    {
      name: "rejects a session-only attachment without usable media",
      result: { payloads: [{ attachments: [{}] }] },
      expected: {
        delivered: false,
        path: "direct",
        reason: "visible_reply_missing",
        error: "completion agent did not produce a visible reply",
      },
    },
    {
      name: "rejects non-subagent session-only completion without the required result after NO_REPLY",
      result: { payloads: [], meta: { terminalReply: { disposition: "silent" } } },
      sourceTool: "agent_harness_task",
      expected: {
        delivered: false,
        path: "direct",
        reason: "visible_reply_missing",
        error: "completion agent did not produce a visible reply",
      },
    },
    {
      name: "rejects session-only completion without a result after committed session spawn",
      result: { payloads: [], ...committedSessionSpawnEvidence },
      expected: {
        delivered: false,
        path: "direct",
        reason: "visible_reply_missing",
        error: "completion agent did not produce a visible reply",
      },
    },
    {
      name: "rejects session-only completion without a result after committed cron add",
      result: { payloads: [], successfulCronAdds: 1 },
      expected: {
        delivered: false,
        path: "direct",
        reason: "visible_reply_missing",
        error: "completion agent did not produce a visible reply",
      },
    },
  ])("$name", async ({ result: gatewayResult, sourceTool, expected }) => {
    const dispatchGatewayMethodInProcess = createInProcessGatewayMock({
      status: "ok",
      inputProcessingCompleted: true,
      result: gatewayResult,
    });
    testing.setDepsForTest({
      dispatchGatewayMethodInProcess,
      getRequesterSessionActivity: requesterActivity("requester-session-local", false),
      getRuntimeConfig: () => ({}),
    });
    const result = await deliverAnnouncement({
      requesterSessionKey: "agent:main:local-session",
      bestEffortDeliver: true,
      directIdempotencyKey: "announce-local",
      sourceTool,
    });
    expectInProcessAgentParams(dispatchGatewayMethodInProcess, {
      deliver: false,
      channel: undefined,
      to: undefined,
      bestEffortDeliver: true,
    });
    if (expected) {
      expectRecordFields(result, expected);
    } else {
      expectDeliveryPath(result, "direct");
    }
  });

  it("reports requester-agent delivery failure even when output stayed visible", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [{ text: "Tests passed and the PR is ready for review." }],
        deliveryStatus: {
          status: "failed",
          errorMessage: "Slack send failed: channel not found",
        },
      },
    });
    const sendMessage = createSendMessageMock();
    const result = await deliverSlackThreadAnnouncement({
      callGateway,
      sendMessage,
      directIdempotencyKey: "announce-thread-delivery-status-failed",
      internalEvents: taskCompletionEvents({
        childSessionId: "child-session-id",
        taskLabel: "thread completion smoke",
      }),
    });

    expectRecordFields(result, {
      delivered: false,
      path: "direct",
      error: "Slack send failed: channel not found",
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not credit stale thread completions after no-visible-payload suppression", async () => {
    const deliveryStatus = {
      requested: true,
      attempted: false,
      status: "suppressed",
      succeeded: true,
      reason: "no_visible_payload",
      resultCount: 0,
    };
    const callOrder: string[] = [];
    const callGateway = createGatewayMock({ result: { payloads: [], deliveryStatus } }, () => {
      callOrder.push("gateway");
    });
    const sendMessage = createSendMessageMock();
    const result = await deliverSlackThreadAnnouncement({
      callGateway,
      sendMessage,
      isActive: true,
      directIdempotencyKey: "announce-thread-fallback-empty",
      internalEvents: taskCompletionEvents({
        childSessionId: "child-session-id",
        taskLabel: "thread completion smoke",
      }),
    });

    expect(result).toMatchObject({
      delivered: false,
      path: "direct",
      reason: "visible_reply_missing",
    });
    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(["gateway"]);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("keeps typed missing output retryable without completion steering", async () => {
    const callGateway = createPayloadGatewayMock();
    const sendMessage = createSendMessageMock();
    const childSessionKey = "agent:worker:subagent:empty-success";
    const result = await deliverDiscordDirectMessageCompletion({
      callGateway,
      sendMessage,
      isActive: true,
      sourceSessionKey: childSessionKey,
      internalEvents: taskCompletionEvents({
        childSessionKey,
        childSessionId: "child-session-id",
        status: "ok",
        statusLabel: "completed successfully",
        result: "(no output)",
        noVisibleResult: true,
      }),
    });

    expectRecordFields(result, {
      delivered: false,
      path: "direct",
      error: "completion agent did not produce a visible reply",
      reason: "visible_reply_missing",
    });
    expect(result.terminal).toBeUndefined();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not restart a requester after timeout", async () => {
    const callGateway = createPayloadGatewayMock({ text: "child completion output" });
    const sendMessage = createSendMessageMock();
    const result = await deliverTelegramDirectMessageCompletion({
      callGateway,
      sendMessage,
      requesterAbandonment: "timeout",
      isActive: false,
      internalEvents: taskCompletionEvents({
        childSessionId: "child-session-id",
        taskLabel: "telegram late completion",
      }),
    });
    expectRecordFields(result, {
      delivered: false,
      path: "none",
      reason: "requester_abandoned",
      error: "requester session abandoned after timeout",
    });
    expect(callGateway).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("queues completion until the requester's timeout recovery releases its turn", async () => {
    const route = deliveryRoutes.telegram;
    const target = captureSessionTarget({
      storeScope: "/synthetic/requester-timeout-recovery/sessions.db",
      sessionKey: route.key,
      incarnation: route.sessionId,
      agentId: "main",
    });
    const recoveryEntered = createDeferredCore();
    const releaseRecovery = createDeferredCore();
    const recovery = withSessionTurn(
      { target, sessionKey: route.key, sessionId: route.sessionId },
      async (operation) => {
        if (!operation) {
          throw new Error("Timeout recovery requires its retained controller operation");
        }
        operation.setPhase("preflight_compacting");
        recoveryEntered.resolve();
        await releaseRecovery.promise;
      },
    );
    const callGateway = createPayloadGatewayMock({ text: "child completion output" });
    const sendMessage = createSendMessageMock();
    let delivery: ReturnType<typeof deliverTelegramDirectMessageCompletion> | undefined;
    let input: ReturnType<typeof reserveSessionControllerSource> | undefined;
    try {
      await awaitGateBeforeSettlement(
        recoveryEntered.promise,
        recovery,
        "Recovery exited before retaining its controller turn",
      );
      input = reserveSessionControllerSource(route.key, {
        target,
        reservationId: "timeout-recovery-completion",
        policy: { mode: "followup" },
      });
      const recoveryClaim = input.mailbox.claim;
      expect(recoveryClaim).toBeDefined();
      delivery = deliverTelegramDirectMessageCompletion({
        callGateway,
        sendMessage,
        controllerInput: input,
        requesterAbandonment: "recovering_timeout",
        isActive: false,
        internalEvents: taskCompletionEvents({
          childSessionId: "child-session-id",
          taskLabel: "telegram recovering completion",
        }),
      });
      await awaitGateBeforeSettlement(
        vi.waitFor(() => expect(input?.phase).toBe("waiting")),
        delivery,
        "Completion settled before waiting behind timeout recovery",
      );
      expect(input.mailbox.claim).toBe(recoveryClaim);
      expect(callGateway).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();
      releaseRecovery.resolve();
      await recovery;
      await expect(delivery).resolves.toMatchObject({ delivered: true, path: "direct" });
      await input.settlement.promise;
      expect(callGateway).toHaveBeenCalledOnce();
      expect(sendMessage).not.toHaveBeenCalled();
      expect(input.mailbox.entries).toEqual([]);
    } finally {
      releaseRecovery.resolve();
      if (input) {
        retireSessionControllerInput(input);
      }
      await Promise.allSettled([recovery, ...(delivery ? [delivery] : [])]);
    }
  });

  const generatedVideoAttachment = {
    type: "video",
    path: "/tmp/generated-corgi.mp4",
    name: "generated-corgi.mp4",
    mimeType: "video/mp4",
    sizeBytes: 9012,
    durationMs: 8_000,
    width: 1280,
    height: 720,
  } satisfies NonNullable<AgentInternalEvent["attachments"]>[number];
  it.each<{
    name: string;
    route: keyof typeof deliveryRoutes;
    sourceTool: string;
    events: AgentInternalEvent[];
    options?: Partial<DeliveryFixtureParams>;
    expected: Record<string, unknown>;
    noAttachments?: boolean;
  }>([
    {
      name: "video completion without opt-in or direct delivery",
      route: "discord",
      sourceTool: "video_generate",
      events: taskCompletionEvents({
        source: "video_generation",
        childSessionKey: "video_generate:task-123",
        childSessionId: "task-123",
        announceType: "video generation task",
        mediaUrls: [generatedVideoAttachment.path],
        attachments: [generatedVideoAttachment],
      }),
      expected: {
        kind: "agentTurn",
        sessionKey: "agent:main:discord:dm:U123",
        inputProvenance: expect.objectContaining({
          kind: "inter_session",
          sourceTool: "video_generate",
        }),
        sourceReplyDeliveryMode: "automatic",
        expectedMediaUrls: [generatedVideoAttachment.path],
        expectedMediaAttachments: { [generatedVideoAttachment.path]: generatedVideoAttachment },
        idempotencyKey: "announce-dm-fallback-empty:agent-loop",
      },
    },
    {
      name: "generated-media failure notice without raw delivery",
      route: "discord",
      sourceTool: "music_generate",
      events: musicCompletionEvents({
        status: "error",
        statusLabel: "failed",
        result: "All music generation models failed.",
        mediaUrls: undefined,
      }),
      expected: { expectedMediaUrls: [] },
      noAttachments: true,
    },
    {
      name: "video completion with a stringified Telegram topic",
      route: "telegram",
      sourceTool: "video_generate",
      options: {
        requesterSessionKey: "agent:main:telegram:group:-1003970070733:topic:1",
        origin: {
          channel: "telegram",
          to: "telegram:-1003970070733",
          accountId: "bot-1",
          threadId: 1,
        },
      },
      events: taskCompletionEvents({
        source: "video_generation",
        childSessionKey: "video_generate:task-123",
        childSessionId: "task-123",
        announceType: "video generation task",
        taskLabel: "anime corgi skateboard",
        result: "Generated 1 video.\nMEDIA:/tmp/generated-corgi.mp4",
        mediaUrls: ["/tmp/generated-corgi.mp4"],
        replyInstruction: "Deliver the generated video through the message tool.",
      }),
      expected: {
        route: expect.objectContaining({
          channel: "telegram",
          accountId: "bot-1",
          to: "telegram:-1003970070733",
          threadId: "1",
        }),
        expectedMediaUrls: ["/tmp/generated-corgi.mp4"],
      },
    },
    {
      name: "generated media before attempting active-requester handoff",
      route: "channel",
      sourceTool: "image_generate",
      options: {
        isActive: true,
        directIdempotencyKey: "announce-channel-media-handoff-locked",
        runtimeConfig: { messages: { groupChat: { visibleReplies: "message_tool" } } },
      },
      events: imageCompletionEvents({
        childSessionKey: "image_generate:task-locked",
        childSessionId: "task-locked",
        taskLabel: "locked handoff image",
        result: "Generated 1 image.\nMEDIA:/tmp/generated-locked.png",
        mediaUrls: ["/tmp/generated-locked.png"],
        replyInstruction: "Tell the user the image is ready and send it through the message tool.",
      }),
      expected: {
        kind: "agentTurn",
        sessionKey: "agent:main:slack:channel:C123",
        message: expect.stringContaining("generated-locked.png"),
        messageId: "announce-channel-media-handoff-locked:agent-loop",
        route: { channel: "slack", to: "channel:C123", accountId: "acct-1", chatType: "channel" },
        inputProvenance: {
          kind: "inter_session",
          sourceChannel: "internal",
          sourceTool: "image_generate",
        },
        sourceReplyDeliveryMode: "message_tool_only",
        expectedMediaUrls: ["/tmp/generated-locked.png"],
        idempotencyKey: "announce-channel-media-handoff-locked:agent-loop",
      },
    },
  ])("queues $name", async ({ route, sourceTool, events, options, expected, noAttachments }) => {
    const callGateway = createPayloadGatewayMock();
    const sendMessage = createSendMessageMock();
    const result = await deliverFixture(route, {
      callGateway,
      sendMessage,
      sourceTool,
      internalEvents: events,
      ...options,
    });

    expectDeliveryPath(result, "queued");
    expect(callGateway).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sessionDeliveryQueueMocks.enqueueClaimedSessionDelivery).toHaveBeenCalledWith(
      expect.objectContaining(expected),
      expect.any(Number),
      expectQueueContext(),
    );
    if (noAttachments) {
      expect(
        sessionDeliveryQueueMocks.enqueueClaimedSessionDelivery.mock.calls.at(-1)?.[0],
      ).not.toHaveProperty("expectedMediaAttachments");
    }
    expect(sessionDeliveryQueueMocks.releaseSessionDeliveryClaim).toHaveBeenCalledWith(
      "session-delivery-media",
      expectQueueContext(),
    );
    expect(sessionDeliveryQueueMocks.scheduleSessionDelivery).toHaveBeenCalledWith(
      "session-delivery-media",
      expectQueueContext(),
    );
  });

  it.each(["unavailable", "failed", "completed"] as const)(
    "handles %s durable media persistence",
    async (status) => {
      if (status === "unavailable") {
        sessionDeliveryQueueMocks.enqueueClaimedSessionDelivery.mockImplementationOnce(() => {
          throw new Error("state database unavailable");
        });
      } else {
        sessionDeliveryQueueMocks.enqueueClaimedSessionDelivery.mockReturnValueOnce({
          id: "session-delivery-media",
          claimed: false,
          status,
        });
      }
      const callGateway = createPayloadGatewayMock();
      const sendMessage = createSendMessageMock();

      const result = await deliverDiscordDirectMessageCompletion({
        callGateway,
        sendMessage,
        sourceTool: "music_generate",
        internalEvents: musicCompletionEvents(),
      });

      expectRecordFields(
        result,
        status === "completed"
          ? { delivered: true, path: "queued" }
          : {
              delivered: false,
              path: "queued",
              reason: "completion_handoff_unavailable",
              disposition: status === "failed" ? "permanent_failure" : "retryable",
            },
      );
      expect(callGateway).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();
      if (status !== "unavailable") {
        expect(sessionDeliveryQueueMocks.scheduleSessionDelivery).not.toHaveBeenCalled();
      }
    },
  );

  it("keeps private generated media on the owning session agent loop", async () => {
    const callGateway = createGatewayMock();
    const sendMessage = createSendMessageMock();
    testing.setDepsForTest({
      callGateway,
      getRequesterSessionActivity: requesterActivity("requester-subagent-session", false),
      getRuntimeConfig: () => ({ messages: { groupChat: { visibleReplies: "message_tool" } } }),
      loadRequesterSessionEntry: (sessionKey) => ({
        cfg: {},
        entry: {
          sessionId: "requester-subagent-session",
          updatedAt: 1,
          chatType: "channel",
        },
        canonicalKey: sessionKey,
      }),
      sendMessage,
    });

    const result = await deliverSubagentAnnouncement({
      requesterSessionKey: "agent:worker:subagent:parent",
      targetRequesterSessionKey: "agent:worker:subagent:parent",
      triggerMessage: "child done",
      requesterIsSubagent: true,
      expectsCompletionMessage: true,
      bestEffortDeliver: true,
      directIdempotencyKey: "announce-private-media-payload",
      sourceTool: "image_generate",
      internalEvents: imageCompletionEvents({
        taskLabel: "private proof image",
        result: "Generated 1 image.\nMEDIA:/tmp/generated-private.png",
        mediaUrls: ["/tmp/generated-private.png"],
        replyInstruction: "Tell the user the image is ready and include the generated media.",
      }),
      sourceRunId: "run-generated-media",
    });

    expectDeliveryPath(result, "queued");
    expect(callGateway).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sessionDeliveryQueueMocks.enqueueClaimedSessionDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        route: {
          channel: "webchat",
          to: "agent:worker:subagent:parent",
          chatType: "direct",
        },
        sourceReplyDeliveryMode: "automatic",
      }),
      expect.any(Number),
      expectQueueContext(),
    );
    expect(sessionDeliveryQueueMocks.scheduleSessionDelivery).toHaveBeenCalledWith(
      "session-delivery-media",
      expectQueueContext(),
    );
  });

  const missingVisibleCompletion = {
    delivered: false,
    path: "direct",
    reason: "visible_reply_missing",
    error: "completion agent did not produce a visible reply",
  };
  const silentGatewayResult = {
    payloads: [],
    meta: { terminalReply: { disposition: "silent" } },
    deliveryStatus: sentDeliveryStatus,
  };
  type NoOutputCompletionCase = [
    name: string,
    gatewayResult: Record<string, unknown>,
    expected: Record<string, unknown>,
    mode: "automatic" | "queued" | "off-target",
    event?: NonNullable<Parameters<typeof taskCompletionEvents>[0]>,
  ];
  it.each<NoOutputCompletionCase>([
    [
      "rejects missing automatic visible delivery",
      { payloads: [], meta: { terminalReply: { disposition: "silent" } } },
      missingVisibleCompletion,
      "automatic",
    ],
    [
      "blocks automatic replay after committed outbound side effects",
      { payloads: [], ...committedSessionSpawnEvidence },
      { ...missingVisibleCompletion, disposition: "permanent_failure" },
      "automatic",
    ],
    [
      "fails error completions when parent silently skips the required message tool",
      silentGatewayResult,
      {
        delivered: false,
        path: "direct",
        reason: "message_tool_delivery_missing",
        error: "completion agent did not use the message tool for message-tool-only delivery",
      },
      "queued",
      { status: "error", statusLabel: "failed" },
    ],
    // These paired regressions distinguish the producer's absence fact from placeholder wording.
    [
      "gates a reworded no-visible-result placeholder",
      silentGatewayResult,
      missingVisibleCompletion,
      "queued",
      { result: "(no result yet; child still running)" },
    ],
    [
      "does not gate a result that only reads like the placeholder",
      silentGatewayResult,
      { delivered: true, path: "direct" },
      "queued",
      { noVisibleResult: undefined },
    ],
    [
      "rejects off-target messaging alone",
      {
        payloads: [],
        didSendViaMessagingTool: true,
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "slack",
            accountId: "acct-1",
            to: "channel:OTHER",
            text: "An unrelated channel update.",
          },
        ],
      },
      { ...missingVisibleCompletion, disposition: "permanent_failure" },
      "off-target",
    ],
  ])("%s for no-output channel completion", async (_name, gatewayResult, expected, mode, event) => {
    const callGateway = createGatewayMock({ result: gatewayResult });
    const sendMessage = mode === "off-target" ? createSendMessageMock() : undefined;
    const childSessionKey = "agent:worker:subagent:no-output";
    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      sendMessage,
      directIdempotencyKey: "announce-channel-no-output",
      sourceTool: "subagent_announce",
      sourceSessionKey: childSessionKey,
      runtimeConfig:
        mode === "automatic" ? {} : { messages: { groupChat: { visibleReplies: "message_tool" } } },
      internalEvents: taskCompletionEvents({
        childSessionKey,
        childSessionId: "child-session-id",
        result: "(no output)",
        noVisibleResult: true,
        ...event,
      }),
    });
    expectRecordFields(result, expected);
    const request = expectRecordFields(mockCallArg(callGateway), { method: "agent" });
    const isValid = validateAgentParams(request.params);
    expect(isValid ? "" : formatValidationErrors(validateAgentParams.errors)).toBe("");
    if (sendMessage) {
      expect(sendMessage).not.toHaveBeenCalled();
    }
  });

  it("delivers Telegram forum-topic subagent completions through the normal parent handoff", async () => {
    const callGateway = createPayloadGatewayMock({ text: "The delegated task is complete." });
    const result = await deliverTelegramDirectMessageCompletion({
      callGateway,
      requesterSessionKey: "agent:main:telegram:group:-1003871627242:topic:6823",
      origin: {
        channel: "telegram",
        to: "telegram:-1003871627242",
        accountId: "bot-1",
        threadId: 6823,
      },
      sourceTool: "subagent_announce",
      internalEvents: taskCompletionEvents({
        childSessionKey: "agent:codex:subagent:child",
        childSessionId: "child-session-id",
        taskLabel: "telegram forum completion smoke",
        result: "delegated task output",
      }),
    });
    expectDeliveryPath(result, "direct");
    expect(callGateway).toHaveBeenCalledTimes(1);
    expectGatewayAgentParams(callGateway, {
      deliver: true,
      channel: "telegram",
      accountId: "bot-1",
      to: "telegram:-1003871627242",
      threadId: "6823",
    });
  });

  it("fails configured channel subagent completions when parent skips required message tool", async () => {
    const callGateway = createPayloadGatewayMock({ text: "The subagent is done." });
    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      directIdempotencyKey: "announce-channel-subagent-message-tool-missing",
      sourceTool: "subagent_announce",
      runtimeConfig: { messages: { groupChat: { visibleReplies: "message_tool" } } },
      internalEvents: taskCompletionEvents({
        childSessionId: "child-session-id",
        taskLabel: "channel completion smoke",
      }),
    });

    expectRecordFields(result, {
      delivered: false,
      path: "direct",
      reason: "message_tool_delivery_missing",
      error: "completion agent did not use the message tool for message-tool-only delivery",
      disposition: "permanent_failure",
    });
    expect(callGateway).toHaveBeenCalledTimes(1);
  });

  it.each(["accepted", "in_flight", "yielded"] as const)(
    "does not replay a still-owned %s completion handoff",
    async (state) => {
      const callGateway = createGatewayMock(
        state === "yielded"
          ? { status: "ok", result: { payloads: [], meta: { yielded: true } } }
          : { status: state },
      );
      const result = await deliverSlackChannelAnnouncement({
        callGateway,
        directIdempotencyKey: `announce-pending-message-tool-${state}`,
        sourceTool: "subagent_announce",
        runtimeConfig: { messages: { groupChat: { visibleReplies: "message_tool" } } },
        internalEvents: taskCompletionEvents({ childSessionId: "child-session-id" }),
      });
      expectRecordFields(
        result,
        state === "yielded"
          ? {
              delivered: false,
              reason: "completion_handoff_pending",
              disposition: "session_queued",
            }
          : { delivered: true, path: "direct" },
      );
      expect(callGateway).toHaveBeenCalledTimes(1);
    },
  );

  it("records a committed direct completion when the announce turn ends incomplete", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [],
        deliveryStatus: {
          status: "failed",
          errorMessage: "Agent couldn't generate a response.",
        },
        didSendViaMessagingTool: true,
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "discord",
            accountId: "acct-1",
            to: "dm:U123",
            text: "QA-SUBAGENT-TERMINAL-EMPTY-REPRESENTED",
            sourceReplyFinal: true,
          },
        ],
      },
    });
    const result = await deliverDiscordDirectMessageCompletion({
      callGateway,
      sourceTool: "subagent_announce",
      internalEvents: taskCompletionEvents({
        childSessionId: "child-session-id",
        result: "(no output)",
        noVisibleResult: true,
      }),
    });

    expectDeliveryPath(result, "direct");
  });

  const requesterTarget = { provider: "discord", accountId: "acct-1", to: "dm:U123" };
  const otherTarget = { ...requesterTarget, to: "dm:OTHER" };
  it.each<
    [
      name: string,
      target: Record<string, unknown>,
      fallsBack: boolean,
      evidence?: Record<string, unknown>,
    ]
  >([
    [
      "accepts legacy targetless delivery on the requester provider",
      { provider: "message" },
      false,
    ],
    ["repairs a completion sent to another recipient", otherTarget, true],
    ["repairs a targetless completion sent through another provider", { provider: "slack" }, true],
    [
      "repairs a completion sent through another requester account",
      { ...requesterTarget, accountId: "acct-other" },
      true,
    ],
    [
      "preserves authoritative source delivery alongside an unrelated send",
      otherTarget,
      false,
      { didDeliverSourceReplyViaMessageTool: true },
    ],
    [
      "preserves targetless source media alongside an unrelated targeted send",
      { ...otherTarget, mediaUrls: ["/tmp/unrelated.mp3"] },
      false,
      { messagingToolSentMediaUrls: ["/tmp/current-source.mp3"] },
    ],
    [
      "does not mistake an off-target attachment for targetless source media",
      { ...otherTarget, mediaUrls: ["/tmp/off-target.mp3"] },
      true,
      { messagingToolSentMediaUrls: ["/tmp/off-target.mp3"] },
    ],
  ])("%s", async (_name, target, fallsBack, evidence) => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [],
        didSendViaMessagingTool: true,
        ...evidence,
        messagingToolSentTargets: [
          { tool: "message", ...target, text: "The subagent is done: child completion output" },
        ],
      },
    });
    const sendMessage = createSendMessageMock();
    const result = await deliverDiscordDirectMessageCompletion({
      callGateway,
      sendMessage,
      sourceTool: "subagent_announce",
      internalEvents: taskCompletionEvents({ childSessionId: "child-session-id" }),
    });

    expectDeliveryPath(result, "direct");
    if (fallsBack) {
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "discord",
          accountId: "acct-1",
          to: "dm:U123",
          content: "child completion output",
        }),
      );
    } else {
      expect(sendMessage).not.toHaveBeenCalled();
    }
  });

  it("falls back to the external requester route when completion origin is internal", async () => {
    const callGateway = createPayloadGatewayMock({ text: "child completion output" });
    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      directIdempotencyKey: "announce-channel-internal-origin",
      completionDirectOrigin: {
        channel: "webchat",
      },
      internalEvents: taskCompletionEvents({
        childSessionId: "child-session-id",
        taskLabel: "channel completion smoke",
      }),
    });

    expectDeliveryPath(result, "direct");
  });

  const ambiguousCompletion = { delivered: false, disposition: "ambiguous" };
  const suppressedCompletionReceipt = (reasons: string[]) => ({
    requested: true,
    attempted: true,
    status: "suppressed",
    succeeded: true,
    resultCount: 0,
    reason: reasons[0],
    payloadOutcomes: reasons.map((reason, index) => ({ index, status: "suppressed", reason })),
  });
  it.each([
    {
      name: "unidentified adapter after no_visible_payload",
      payloads: [{ text: "Generated completion 0" }, { text: "Generated completion 1" }],
      deliveryStatus: suppressedCompletionReceipt([
        "no_visible_payload",
        "adapter_returned_no_identity",
      ]),
      expected: ambiguousCompletion,
    },
    {
      name: "empty output before a hook cancellation",
      payloads: [{ text: "" }, { text: "Cancelled completion" }],
      deliveryStatus: suppressedCompletionReceipt([
        "no_visible_payload",
        "cancelled_by_message_sending_hook",
      ]),
      expected: {
        delivered: false,
        disposition: "intentional_non_delivery",
        reason: "delivery_suppressed",
        error: "cancelled_by_message_sending_hook",
      },
    },
    {
      name: "unidentified adapter before a later failure",
      payloads: [{ text: "Unidentified completion" }, { text: "Failed supplement" }],
      deliveryStatus: {
        requested: true,
        attempted: true,
        status: "failed",
        succeeded: false,
        error: true,
        errorMessage: "supplement failed",
        payloadOutcomes: [
          { index: 0, status: "suppressed", reason: "adapter_returned_no_identity" },
          {
            index: 1,
            status: "failed",
            sentBeforeError: false,
            stage: "platform_send",
            error: "supplement failed",
          },
        ],
      },
      expected: ambiguousCompletion,
    },
    {
      name: "partial send without per-payload details",
      deliveryStatus: {
        requested: true,
        attempted: true,
        status: "partial_failed",
        succeeded: "partial",
        resultCount: 1,
        sentBeforeError: true,
        error: true,
        errorMessage: "supplement failed",
      },
      expected: ambiguousCompletion,
    },
    { name: "empty", deliveryStatus: { status: "sent", resultCount: 0 } },
  ])("does not credit a $name automatic completion receipt", async (testCase) => {
    const { deliveryStatus, expected } = testCase;
    const payloads = "payloads" in testCase ? testCase.payloads : undefined;
    const callGateway = createGatewayMock({
      result: {
        payloads: payloads ?? [{ text: "Generated completion" }],
        deliveryStatus,
      },
    });
    const result = await deliverSlackThreadAnnouncement({
      callGateway,
      directIdempotencyKey: "announce-undelivered-receipt",
    });

    expect(result).toMatchObject(
      expected ?? {
        delivered: false,
        reason: "visible_reply_missing",
      },
    );
    expect(result.requesterVisibleFinalDelivered).toBeUndefined();
    if (expected?.disposition === "ambiguous") {
      expect(result.reason).toBeUndefined();
      expect(result.terminal).toBeUndefined();
    }
  });

  const requesterSettleCases = createRequesterSettleCases();

  it.each(
    requesterSettleCases.flatMap((testCase) =>
      testCase.routes.map((route) => ({ testCase, route })),
    ),
  )("$route.name: $testCase.name", async ({ testCase, route }) => {
    const { result: gatewayResult, requireVisibleReply, expected } = testCase;
    const callGateway = createGatewayMock({
      status: testCase.status ?? "ok",
      ...(gatewayResult === undefined ? {} : { result: gatewayResult }),
    });
    const sendMessage = createSendMessageMock();
    testing.setDepsForTest({
      callGateway,
      getRequesterSessionActivity: requesterActivity("requester-session-dm", true),
      getRuntimeConfig: () => ({}),
      sendMessage,
    });
    const result = await deliverSubagentAnnouncement({
      requesterSessionKey: route.sessionKey,
      targetRequesterSessionKey: route.sessionKey,
      triggerMessage: "all spawned subagents settled",
      requesterSessionOrigin: route.origin,
      directOrigin: route.origin,
      requesterIsSubagent: route.requesterIsSubagent,
      expectsCompletionMessage: false,
      ...(requireVisibleReply ? { requireVisibleReply: true } : {}),
      directIdempotencyKey: "announce-requester-settle-direct",
      sourceTool: "subagent_settle",
    });
    expect(result).toMatchObject(expected);
    expect(result.requesterVisibleFinalDelivered).toBe(
      testCase.recordsVisibleFinal && !route.requesterIsSubagent ? true : undefined,
    );
    expect(result.finalAssistantVisibleText).toBe(
      route.requesterIsSubagent ? undefined : testCase.expectedFinalText,
    );
    expect(sendMessage).not.toHaveBeenCalled();
    const agentParams = expectGatewayAgentParams(callGateway, route.agentParams);
    expect(agentParams.sourceReplyDeliveryMode).toBeUndefined();
  });

  const identifiedSend = new OutboundDeliveryError("connect ECONNRESET", {
    cause: new Error("connect ECONNRESET"),
    results: [{ channel: "telegram", messageId: "msg-already-sent" }],
  });
  const writerRebound = (cause?: Error) =>
    Object.assign(
      new Error("session writer claim changed before transcript persistence", { cause }),
      {
        name: "SessionTranscriptWriterClaimReboundError",
      },
    );
  type FailureCase = [
    name: string,
    error: Error,
    outcome: "permanent_failure" | "ambiguous" | "retryable",
    route?: "active" | "direct" | "sent-marker",
  ];
  // A failed dispatch is recorded once; these cases pin its classification.
  it.each<FailureCase>([
    [
      "leaves a parent restart admission race retryable for the lifecycle owner",
      new Error(
        'Session "agent:main:main" changed while starting work. Retry. | SESSION_WORK_START_CHANGED',
      ),
      "retryable",
    ],
    [
      "classifies wrapped permanent channel failures as permanent",
      new Error("outbound delivery failed", { cause: new Error("chat not found") }),
      "permanent_failure",
    ],
    [
      "honors typed permanent rejection over a transient-looking cause",
      new Error("outbound delivery failed", {
        cause: new PlatformMessageNotDispatchedError("payload rejected by platform policy", {
          cause: new Error("connect ECONNRESET"),
          retryable: false,
        }),
      }),
      "permanent_failure",
    ],
    ["never retries after an identified outbound platform send", identifiedSend, "ambiguous"],
    [
      "never retries after a nested visible reply receipt",
      new Error("connect ECONNRESET", {
        cause: Object.assign(new Error("platform send completed"), { visibleReplySent: true }),
      }),
      "ambiguous",
    ],
    [
      "does not retry writer rebound with send evidence",
      writerRebound(identifiedSend),
      "ambiguous",
      "active",
    ],
    ["keeps writer rebound retryable after one dispatch", writerRebound(), "retryable"],
    [
      "keeps wrapped writer rebound retryable after one dispatch",
      new Error("requester handoff failed", { cause: writerRebound() }),
      "retryable",
    ],
    [
      "keeps a permanent cause of writer rebound permanent",
      writerRebound(new Error("chat not found")),
      "permanent_failure",
    ],
    [
      "does not text-fallback after an identified incomplete platform send",
      new OutboundDeliveryError("incomplete terminal response", {
        cause: new Error("incomplete terminal response"),
        results: [{ channel: "discord", messageId: "already-sent" }],
      }),
      "ambiguous",
      "direct",
    ],
    [
      "detects sentBeforeError on writer rebound and prevents retry",
      Object.assign(writerRebound(), { sentBeforeError: true }),
      "ambiguous",
    ],
  ])("%s", async (_name, error, outcome, route) => {
    const callGateway = createGatewayMock();
    vi.mocked(callGateway).mockRejectedValue(error);
    const sendMessage = createSendMessageMock();
    const result =
      route === "direct"
        ? await deliverDiscordDirectMessageCompletion({
            callGateway,
            sendMessage,
            sourceTool: "subagent_announce",
            internalEvents: taskCompletionEvents({ childSessionId: "child-session-id" }),
          })
        : await deliverSlackChannelAnnouncement({
            callGateway,
            directIdempotencyKey: "announce-retry-contract",
            ...(route === "active" ? { isActive: true } : {}),
          });
    expect(result).toMatchObject({ delivered: false, path: "direct", disposition: outcome });
    expect(callGateway).toHaveBeenCalledOnce();
    if (route === "direct") {
      expect(sendMessage).not.toHaveBeenCalled();
    }
    if (route === "sent-marker") {
      expect(testing.hasAnnounceSendEvidence(error)).toBe(true);
    }
  });

  it("does not text-fallback when source ownership changes during the Gateway attempt", async () => {
    let sourceEffectsAllowed = true;
    const callGateway = createGatewayMock({}, () => {
      sourceEffectsAllowed = false;
      throw new Error("incomplete terminal response code=incomplete_result");
    });
    const sendMessage = createSendMessageMock();
    const result = await deliverDiscordDirectMessageCompletion({
      callGateway,
      sendMessage,
      sourceTool: "subagent_announce",
      internalEvents: taskCompletionEvents({ childSessionId: "child-session-id" }),
      isSourceSessionEffectsAllowed: () => sourceEffectsAllowed,
    });

    expect(result).toMatchObject({
      delivered: false,
      path: "none",
      reason: "source_owner_changed",
      terminal: true,
    });
    expect(callGateway).toHaveBeenCalledOnce();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
