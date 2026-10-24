import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateAgentParams } from "../../../../packages/gateway-protocol/src/index.js";
import { formatValidationErrors } from "../../../../packages/gateway-protocol/src/validation-errors.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { callGateway as runtimeCallGateway } from "../../../gateway/call.js";
import { authorizeGatewaySessionCreation } from "../../../gateway/operator-role-policy.js";
import type { dispatchGatewayMethodInProcess as runtimeDispatchGatewayMethodInProcess } from "../../../gateway/server-plugins.js";
import {
  OutboundDeliveryError,
  PlatformMessageNotDispatchedError,
} from "../../../infra/outbound/deliver-types.js";
import { sendMessage as runtimeSendMessage } from "../../../infra/outbound/message.js";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import { captureSessionTarget } from "../../../sessions/session-controller.lifecycle.js";
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
  return expect.objectContaining({
    environment: fixtureQueueContext.environment,
    admission: expect.objectContaining({
      databasePath: fixtureQueueContext.admission.databasePath,
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

const slackThreadOrigin = {
  channel: "slack",
  to: "channel:C123",
  accountId: "acct-1",
  threadId: "171.222",
} as const;

const sentDeliveryStatus = { status: "sent", resultCount: 1 } as const;
const missingVisibleCompletion = {
  delivered: false,
  path: "direct",
  reason: "visible_reply_missing",
  error: "completion agent did not produce a visible reply",
};
const identifiedCompletion = (overrides: Parameters<typeof taskCompletionEvents>[0] = {}) =>
  taskCompletionEvents({ childSessionId: "child-session-id", ...overrides });
const messageToolConfig = { messages: { groupChat: { visibleReplies: "message_tool" as const } } };
const silentResult = { payloads: [], meta: { terminalReply: { disposition: "silent" } } };
const responseWithResult = (result: Record<string, unknown>) => ({ result });
const discordTarget = { channel: "discord", accountId: "acct-1", to: "dm:U123" };
const missingMessageTool = {
  delivered: false,
  path: "direct",
  reason: "message_tool_delivery_missing",
  error: "completion agent did not use the message tool for message-tool-only delivery",
};

function expectSentMessage(
  sendMessage: typeof runtimeSendMessage,
  fields: Record<string, unknown>,
) {
  expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining(fields));
}
function expectNoExternalDelivery(
  callGateway: typeof runtimeCallGateway,
  sendMessage: typeof runtimeSendMessage,
) {
  expect(callGateway).not.toHaveBeenCalled();
  expect(sendMessage).not.toHaveBeenCalled();
}

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
  currentRequesterSessionId?: string | null;
  requesterAbandonment?: "timeout" | "recovering_timeout";
  requesterEntry?: SessionEntry;
  origin?: AnnouncementInput["directOrigin"];
  requesterOrigin?: AnnouncementInput["directOrigin"];
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
  private: {
    key: "agent:worker:subagent:parent",
    sessionId: "requester-subagent-session",
    origin: undefined,
    id: "announce-private-media-payload",
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
    currentRequesterSessionId,
    requesterAbandonment,
    requesterEntry,
    origin: explicitOrigin,
    requesterOrigin,
    ...delivery
  } = params;
  const route = deliveryRoutes[routeName];
  const origin = explicitOrigin ?? requesterOrigin ?? route.origin;
  const requesterSessionKey = delivery.requesterSessionKey ?? route.key;
  testing.setDepsForTest({
    callGateway,
    sendMessage,
    getRuntimeConfig: () => cfg,
    ...(requesterEntry
      ? {
          loadRequesterSessionEntry: (key: string) => ({
            cfg: {},
            canonicalKey: key,
            entry: requesterEntry,
          }),
        }
      : {}),
    getRequesterSessionActivity: requesterActivity(
      currentRequesterSessionId === null
        ? undefined
        : (currentRequesterSessionId ?? route.sessionId),
      isActive === true,
    ),
    ...(routeName === "thread" || routeName === "telegram"
      ? {
          resolveRequesterSessionAbandonment: () => requesterAbandonment,
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
const deliverDiscordDirectMessageCompletion = (params: DeliveryFixtureParams) =>
  deliverFixture("discord", params);

async function runDelivery(
  route: keyof typeof deliveryRoutes,
  {
    response,
    ...params
  }: Partial<DeliveryFixtureParams> & { response?: Record<string, unknown> | Error } = {},
) {
  const callGateway =
    params.callGateway ?? createGatewayMock(response ?? { result: { payloads: [] } });
  const sendMessage = params.sendMessage ?? createSendMessageMock();
  const result = await deliverFixture(route, { ...params, callGateway, sendMessage });
  return { result, callGateway, sendMessage };
}

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
  const deliveredPayload = (text = "completion") => ({
    result: { payloads: [{ text }], deliveryStatus: sentDeliveryStatus },
  });
  const delivered = { delivered: true, path: "direct" };
  const missingResult = { delivered: false, path: "direct", reason: "visible_reply_missing" };
  const toolOnly = { sourceTool: "subagent_announce", runtimeConfig: messageToolConfig };
  const emptyChild = identifiedCompletion({ result: "(no output)", noVisibleResult: true });
  const sourceFinal = {
    tool: "message",
    provider: "discord",
    accountId: "acct-1",
    to: "dm:U123",
    text: "completion",
    sourceReplyFinal: true,
  };
  const bareRequester = {
    requesterSessionKey: "global",
    requesterAgentId: "research",
    runtimeConfig: {
      session: { scope: "global" },
      agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
    },
  } satisfies Partial<DeliveryFixtureParams>;
  const qaRequester = {
    requesterSessionKey: "agent:qa:subagent-direct-fallback:1234",
    requesterOrigin: { channel: "qa-channel", to: "qa-operator", accountId: "default" },
  };
  const topicOrigin = {
    channel: "telegram",
    to: "telegram:-1003871627242",
    accountId: "bot-1",
    threadId: 6823,
  };
  type CompletionCase = {
    name: string;
    route: keyof typeof deliveryRoutes;
    params?: Partial<DeliveryFixtureParams>;
    response?: Record<string, unknown>;
    expected: Record<string, unknown>;
    sent?: Record<string, unknown>;
    gateway?: Record<string, unknown>;
  };
  it.each`
    name                                | route         | params                                                                                                                                                                                                                         | response                                                                                                                                                                               | expected                                                                                                                             | sent                                                                                                                                      | gateway
    ${"yield custody"}                  | ${"thread"}   | ${{ isActive: true, internalEvents: undefined, isCompletionOwnedByRequesterYield: () => true }}                                                                                                                                | ${undefined}                                                                                                                                                                           | ${{ delivered: false, path: "none", reason: "completion_handoff_pending", terminal: true, disposition: "intentional_non_delivery" }} | ${undefined}                                                                                                                              | ${undefined}
    ${"omitted synthesis result"}       | ${"discord"}  | ${{ internalEvents: identifiedCompletion({ result: "child finding" }) }}                                                                                                                                                       | ${{ result: { payloads: [{ text: "TG88042_NO_REOUTPUT" }] } }}                                                                                                                         | ${delivered}                                                                                                                         | ${{ ...discordTarget, content: "child finding", idempotencyKey: "announce-dm-fallback-empty:text-direct" }}                               | ${undefined}
    ${"bare requester owner"}           | ${"discord"}  | ${bareRequester}                                                                                                                                                                                                               | ${undefined}                                                                                                                                                                           | ${delivered}                                                                                                                         | ${{ requesterSessionKey: "global", agentId: "research", mirror: expect.objectContaining({ sessionKey: "global", agentId: "research" }) }} | ${undefined}
    ${"channel-grammar direct target"}  | ${"channel"}  | ${qaRequester}                                                                                                                                                                                                                 | ${undefined}                                                                                                                                                                           | ${delivered}                                                                                                                         | ${{ ...qaRequester.requesterOrigin, content: "child completion output" }}                                                                 | ${undefined}
    ${"channel target with direct key"} | ${"channel"}  | ${{ requesterSessionKey: "agent:main:discord:dm:U123" }}                                                                                                                                                                       | ${undefined}                                                                                                                                                                           | ${missingResult}                                                                                                                     | ${undefined}                                                                                                                              | ${undefined}
    ${"visible but failed delivery"}    | ${"thread"}   | ${undefined}                                                                                                                                                                                                                   | ${responseWithResult({ payloads: [{ text: "completion" }], deliveryStatus: { status: "failed", errorMessage: "send failed" } })}                                                       | ${{ delivered: false, path: "direct", error: "send failed" }}                                                                        | ${undefined}                                                                                                                              | ${undefined}
    ${"active suppressed completion"}   | ${"thread"}   | ${{ isActive: true }}                                                                                                                                                                                                          | ${responseWithResult({ payloads: [], deliveryStatus: { status: "suppressed", reason: "no_visible_payload", resultCount: 0 } })}                                                        | ${missingResult}                                                                                                                     | ${undefined}                                                                                                                              | ${undefined}
    ${"typed missing child output"}     | ${"discord"}  | ${{ isActive: true, sourceSessionKey: "agent:worker:subagent:empty-success", internalEvents: identifiedCompletion({ childSessionKey: "agent:worker:subagent:empty-success", noVisibleResult: true, result: "(no output)" }) }} | ${undefined}                                                                                                                                                                           | ${{ ...missingVisibleCompletion, terminal: undefined }}                                                                              | ${undefined}                                                                                                                              | ${undefined}
    ${"abandoned requester"}            | ${"telegram"} | ${{ requesterAbandonment: "timeout" }}                                                                                                                                                                                         | ${undefined}                                                                                                                                                                           | ${{ delivered: false, path: "none", reason: "requester_abandoned" }}                                                                 | ${undefined}                                                                                                                              | ${undefined}
    ${"Telegram forum topic"}           | ${"telegram"} | ${{ requesterSessionKey: "agent:main:telegram:group:-1003871627242:topic:6823", origin: topicOrigin, sourceTool: "subagent_announce" }}                                                                                        | ${deliveredPayload()}                                                                                                                                                                  | ${delivered}                                                                                                                         | ${undefined}                                                                                                                              | ${{ ...topicOrigin, threadId: "6823", deliver: true }}
    ${"required message tool missing"}  | ${"channel"}  | ${toolOnly}                                                                                                                                                                                                                    | ${deliveredPayload()}                                                                                                                                                                  | ${{ ...missingMessageTool, disposition: "permanent_failure" }}                                                                       | ${undefined}                                                                                                                              | ${undefined}
    ${"committed final after error"}    | ${"discord"}  | ${{ sourceTool: "subagent_announce", internalEvents: emptyChild }}                                                                                                                                                             | ${responseWithResult({ payloads: [], deliveryStatus: { status: "failed", errorMessage: "response failed" }, didSendViaMessagingTool: true, messagingToolSentTargets: [sourceFinal] })} | ${delivered}                                                                                                                         | ${undefined}                                                                                                                              | ${undefined}
    ${"internal completion origin"}     | ${"channel"}  | ${{ completionDirectOrigin: { channel: "webchat" } }}                                                                                                                                                                          | ${deliveredPayload()}                                                                                                                                                                  | ${delivered}                                                                                                                         | ${undefined}                                                                                                                              | ${undefined}
  `("$name", async ({ name, route, params, response, expected, sent, gateway }: CompletionCase) => {
    if (name === "channel-grammar direct target") {
      registerDirectTargetTestChannel("qa-channel");
    }
    const { result, callGateway, sendMessage } = await runDelivery(route, {
      response: response ?? { result: { payloads: [] } },
      internalEvents: identifiedCompletion(),
      ...params,
    });
    expect(result).toMatchObject(expected);
    if (sent) {
      expectSentMessage(sendMessage, sent);
    } else {
      expect(sendMessage).not.toHaveBeenCalled();
    }
    if (gateway) {
      expectGatewayAgentParams(callGateway, gateway);
    }
    if (expected.path === "none") {
      expect(callGateway).not.toHaveBeenCalled();
    }
  });

  it.each(privateCompletionCases)(
    "preserves private parent consumption and final evidence: $name",
    async (testCase) => {
      const {
        result: delivery,
        callGateway,
        sendMessage,
      } = await runDelivery("discord", {
        response: { status: "ok", inputProcessingCompleted: true, result: testCase.result },
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
    const { result: delivery, sendMessage } = await runDelivery("discord", {
      response,
      completionTarget: "parent",
      internalEvents: taskCompletionEvents(),
    });
    expect(delivery).toMatchObject({ delivered: false, ...expected });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each([null, "replacement-parent"])(
    "does not deliver private completion to a missing or replaced parent: %s",
    async (currentRequesterSessionId) => {
      const { result, callGateway, sendMessage } = await runDelivery("discord", {
        response: { status: "ok", result: { payloads: [] } },
        completionTarget: "parent",
        currentRequesterSessionId,
        internalEvents: taskCompletionEvents(),
      });
      expect(result).toMatchObject({
        delivered: false,
        reason: "completion_handoff_unavailable",
        terminal: true,
      });
      expectNoExternalDelivery(callGateway, sendMessage);
    },
  );

  it.each([
    ["cancelled_by_message_sending_hook", "intentional_non_delivery", "delivery_suppressed"],
    ["adapter_returned_no_identity", "ambiguous", undefined],
  ] as const)(
    "reports %s from direct text completion fallback",
    async (suppressionReason, disposition, reason) => {
      const onDeliveryResult = vi.fn();
      const sendMessage = vi.fn(async () => ({
        channel: "discord",
        to: "dm:U123",
        via: "direct" as const,
        mediaUrl: null,
        deliveryStatus: "suppressed" as const,
        suppressionReason,
      })) as unknown as typeof runtimeSendMessage;

      const { result } = await runDelivery("discord", {
        sendMessage,
        internalEvents: identifiedCompletion(),
        onDeliveryResult,
      });

      expectRecordFields(result, {
        delivered: false,
        path: "direct",
        disposition,
        reason,
      });
      expect(onDeliveryResult).not.toHaveBeenCalled();
      expect(sendMessage).toHaveBeenCalledTimes(1);
    },
  );

  it("sanitizes text while preserving the complete direct completion fallback", async () => {
    const leaked = [
      "Visible completion",
      INTERNAL_RUNTIME_CONTEXT_BEGIN,
      "sourceTool: subagent_announce\nsourceId: video_generate:private",
      INTERNAL_RUNTIME_CONTEXT_END,
      "x".repeat(8_000),
    ].join("\n");
    const modelRouteChange = "Model route changed: requested/model → actual/model.";

    const { sendMessage } = await runDelivery("discord", {
      internalEvents: identifiedCompletion({
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
      const { result, sendMessage } = await runDelivery(route, {
        response: new Error("provider rejected requester synthesis"),
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
    });
    expect(mockCallArg(dispatchGatewayMethodInProcess, 0, 1)).not.toHaveProperty("timeout");
    const dispatchOptions = mockCallArg(dispatchGatewayMethodInProcess, 0, 2);
    expect(dispatchOptions).toMatchObject({
      operatorRoleActor: { kind: "system" },
      delegatedToolPolicyHandoff: {
        sourceSessionKey: "agent:main:subagent:child",
        sourceSessionId: "child-session-local",
        targetSessionKey: "agent:main:slack:channel:C123:thread:171.222",
        targetSessionId: "requester-session-local",
        idempotencyKey: "announce-local-dispatch",
      },
    });
  });

  registerDescendantWakeCurrencyTests({
    createRoleRestrictedInProcessGatewayMock,
    createGatewayMock,
    runDescendantWake,
  });

  it.each<[string, Record<string, unknown>, string?]>([
    ["an attachment without usable media", { payloads: [{ attachments: [{}] }] }],
    ["non-subagent NO_REPLY", silentResult, "agent_harness_task"],
    ["committed session spawn", { payloads: [], ...committedSessionSpawnEvidence }],
    ["committed cron add", { payloads: [], successfulCronAdds: 1 }],
  ])(
    "rejects session-only completion without a result: %s",
    async (_name, gatewayResult, sourceTool) => {
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
      });
      expectRecordFields(result, missingVisibleCompletion);
    },
  );

  const video = {
    type: "video",
    path: "/tmp/corgi.mp4",
    mimeType: "video/mp4",
  } satisfies NonNullable<AgentInternalEvent["attachments"]>[number];
  const videoEvents = (attachments = false) =>
    taskCompletionEvents({
      source: "video_generation",
      childSessionKey: "video_generate:task",
      childSessionId: "task",
      announceType: "video generation task",
      mediaUrls: [video.path],
      ...(attachments ? { attachments: [video] } : {}),
    });
  const imageEvents = imageCompletionEvents({ mediaUrls: ["/tmp/image.png"] });
  type MediaCase = {
    name: string;
    route: keyof typeof deliveryRoutes;
    sourceTool: string;
    events: AgentInternalEvent[];
    options?: Partial<DeliveryFixtureParams>;
    expected: Record<string, unknown>;
  };
  it.each`
    name                        | route         | sourceTool          | events                                                                                     | options                                                                                                                                                                         | expected
    ${"private owning session"} | ${"private"}  | ${"image_generate"} | ${imageEvents}                                                                             | ${{ requesterIsSubagent: true, runtimeConfig: messageToolConfig, requesterEntry: { sessionId: "requester-subagent-session", updatedAt: 1, chatType: "channel" } }}              | ${{ route: { channel: "webchat", to: "agent:worker:subagent:parent", chatType: "direct" }, sourceReplyDeliveryMode: "automatic" }}
    ${"video attachment"}       | ${"discord"}  | ${"video_generate"} | ${videoEvents(true)}                                                                       | ${undefined}                                                                                                                                                                    | ${{ expectedMediaUrls: [video.path], expectedMediaAttachments: { [video.path]: video } }}
    ${"failed generation"}      | ${"discord"}  | ${"music_generate"} | ${musicCompletionEvents({ status: "error", statusLabel: "failed", mediaUrls: undefined })} | ${undefined}                                                                                                                                                                    | ${{ expectedMediaUrls: [] }}
    ${"numeric Telegram topic"} | ${"telegram"} | ${"video_generate"} | ${videoEvents()}                                                                           | ${{ requesterSessionKey: "agent:main:telegram:group:-1003970070733:topic:1", origin: { channel: "telegram", to: "telegram:-1003970070733", accountId: "bot-1", threadId: 1 } }} | ${{ route: expect.objectContaining({ channel: "telegram", accountId: "bot-1", to: "telegram:-1003970070733", threadId: "1" }), expectedMediaUrls: [video.path] }}
    ${"active requester image"} | ${"channel"}  | ${"image_generate"} | ${imageEvents}                                                                             | ${{ isActive: true, runtimeConfig: messageToolConfig }}                                                                                                                         | ${{ route: { channel: "slack", to: "channel:C123", accountId: "acct-1", chatType: "channel" }, sourceReplyDeliveryMode: "message_tool_only", expectedMediaUrls: ["/tmp/image.png"] }}
  `("queues $name", async ({ route, sourceTool, events, options, expected }: MediaCase) => {
    const { result, callGateway, sendMessage } = await runDelivery(route, {
      sourceTool,
      internalEvents: events,
      ...options,
    });
    expectDeliveryPath(result, "queued");
    expectNoExternalDelivery(callGateway, sendMessage);
    const [payload, , context] =
      sessionDeliveryQueueMocks.enqueueClaimedSessionDelivery.mock.lastCall!;
    expect(payload).toMatchObject(expected);
    if (sourceTool === "music_generate") {
      expect(payload).not.toHaveProperty("expectedMediaAttachments");
    }
    expect(context).toEqual(expectQueueContext());
    expect(sessionDeliveryQueueMocks.releaseSessionDeliveryClaim).toHaveBeenCalledWith(
      "session-delivery-media",
      context,
    );
    expect(sessionDeliveryQueueMocks.scheduleSessionDelivery).toHaveBeenCalledWith(
      "session-delivery-media",
      context,
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
      const { result, callGateway, sendMessage } = await runDelivery("discord", {
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

  const silentGatewayResult = {
    ...silentResult,
    deliveryStatus: sentDeliveryStatus,
  };
  type NoOutputCompletionCase = {
    gatewayResult: Record<string, unknown>;
    expected: Record<string, unknown>;
    mode: "automatic" | "queued" | "off-target";
    event?: NonNullable<Parameters<typeof taskCompletionEvents>[0]>;
  };
  const missingAfterEffects = { ...missingVisibleCompletion, disposition: "permanent_failure" };
  const offTargetReply = {
    payloads: [],
    didSendViaMessagingTool: true,
    messagingToolSentTargets: [
      {
        tool: "message",
        provider: "slack",
        accountId: "acct-1",
        to: "channel:OTHER",
        text: "unrelated update",
      },
    ],
  };
  it.each`
    name                           | gatewayResult                                         | expected                    | mode            | event
    ${"missing automatic receipt"} | ${silentResult}                                       | ${missingVisibleCompletion} | ${"automatic"}  | ${undefined}
    ${"committed side effects"}    | ${{ payloads: [], ...committedSessionSpawnEvidence }} | ${missingAfterEffects}      | ${"automatic"}  | ${undefined}
    ${"failed child"}              | ${silentGatewayResult}                                | ${missingMessageTool}       | ${"queued"}     | ${{ status: "error", statusLabel: "failed" }}
    ${"reworded absence"}          | ${silentGatewayResult}                                | ${missingVisibleCompletion} | ${"queued"}     | ${{ result: "(no result yet; child still running)" }}
    ${"visible placeholder"}       | ${silentGatewayResult}                                | ${delivered}                | ${"queued"}     | ${{ noVisibleResult: undefined }}
    ${"off-target message"}        | ${offTargetReply}                                     | ${missingAfterEffects}      | ${"off-target"} | ${undefined}
  `(
    "$name for no-output completion",
    async ({ gatewayResult, expected, mode, event }: NoOutputCompletionCase) => {
      const childSessionKey = "agent:worker:subagent:no-output";
      const { result, callGateway, sendMessage } = await runDelivery("channel", {
        response: { result: gatewayResult },
        sendMessage: mode === "off-target" ? createSendMessageMock() : runtimeSendMessage,
        directIdempotencyKey: "announce-channel-no-output",
        sourceTool: "subagent_announce",
        sourceSessionKey: childSessionKey,
        runtimeConfig: mode === "automatic" ? {} : messageToolConfig,
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
      if (mode === "off-target") {
        expect(sendMessage).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["accepted", "yielded"] as const)(
    "does not replay a still-owned %s completion handoff",
    async (state) => {
      const { result, callGateway } = await runDelivery("channel", {
        sendMessage: runtimeSendMessage,
        response:
          state === "yielded"
            ? { status: "ok", result: { payloads: [], meta: { yielded: true } } }
            : { status: state },
        directIdempotencyKey: `announce-pending-message-tool-${state}`,
        sourceTool: "subagent_announce",
        runtimeConfig: messageToolConfig,
        internalEvents: identifiedCompletion(),
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

  const requesterTarget = { provider: "discord", accountId: "acct-1", to: "dm:U123" };
  const otherTarget = { ...requesterTarget, to: "dm:OTHER" };
  it.each`
    name                           | target                                                    | fallsBack | evidence
    ${"legacy targetless"}         | ${{ provider: "message" }}                                | ${false}  | ${undefined}
    ${"wrong recipient"}           | ${otherTarget}                                            | ${true}   | ${undefined}
    ${"targetless wrong provider"} | ${{ provider: "slack" }}                                  | ${true}   | ${undefined}
    ${"wrong account"}             | ${{ ...requesterTarget, accountId: "acct-other" }}        | ${true}   | ${undefined}
    ${"source receipt"}            | ${otherTarget}                                            | ${false}  | ${{ didDeliverSourceReplyViaMessageTool: true }}
    ${"targetless source media"}   | ${{ ...otherTarget, mediaUrls: ["/tmp/unrelated.mp3"] }}  | ${false}  | ${{ messagingToolSentMediaUrls: ["/tmp/current-source.mp3"] }}
    ${"off-target attachment"}     | ${{ ...otherTarget, mediaUrls: ["/tmp/off-target.mp3"] }} | ${true}   | ${{ messagingToolSentMediaUrls: ["/tmp/off-target.mp3"] }}
  `(
    "checks $name delivery evidence",
    async ({
      target,
      fallsBack,
      evidence,
    }: {
      target: Record<string, unknown>;
      fallsBack: boolean;
      evidence?: Record<string, unknown>;
    }) => {
      const { result, sendMessage } = await runDelivery("discord", {
        response: {
          result: {
            payloads: [],
            didSendViaMessagingTool: true,
            ...evidence,
            messagingToolSentTargets: [
              { tool: "message", ...target, text: "The subagent is done: child completion output" },
            ],
          },
        },
        sourceTool: "subagent_announce",
        internalEvents: identifiedCompletion(),
      });

      expectDeliveryPath(result, "direct");
      if (fallsBack) {
        expectSentMessage(sendMessage, {
          ...discordTarget,
          content: "child completion output",
        });
      } else {
        expect(sendMessage).not.toHaveBeenCalled();
      }
    },
  );

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

  const transient = new Error("connect ECONNRESET");
  const permanent = new Error("chat not found");
  const wrapped = (cause: Error) => new Error("outbound delivery failed", { cause });
  const rejected = new PlatformMessageNotDispatchedError("payload rejected by platform policy", {
    cause: transient,
    retryable: false,
  });
  const visibleReplyError = new Error("connect ECONNRESET", {
    cause: Object.assign(new Error("platform send completed"), { visibleReplySent: true }),
  });
  const incompleteSent = new OutboundDeliveryError("incomplete terminal response", {
    cause: transient,
    results: [{ channel: "discord", messageId: "already-sent" }],
  });
  it.each`
    name                   | error                                                                 | outcome                | direct
    ${"retryable failure"} | ${transient}                                                          | ${"retryable"}         | ${false}
    ${"permanent cause"}   | ${wrapped(permanent)}                                                 | ${"permanent_failure"} | ${false}
    ${"typed rejection"}   | ${wrapped(rejected)}                                                  | ${"permanent_failure"} | ${false}
    ${"visible reply"}     | ${visibleReplyError}                                                  | ${"ambiguous"}         | ${false}
    ${"sent marker"}       | ${Object.assign(new Error("send failed"), { sentBeforeError: true })} | ${"ambiguous"}         | ${false}
    ${"incomplete send"}   | ${incompleteSent}                                                     | ${"ambiguous"}         | ${true}
  `(
    "classifies $name without replay",
    async ({ error, outcome, direct }: { error: Error; outcome: string; direct: boolean }) => {
      const { result, callGateway, sendMessage } = await runDelivery(
        direct ? "discord" : "channel",
        {
          response: error,
          sendMessage: direct ? createSendMessageMock() : runtimeSendMessage,
          ...(direct
            ? { sourceTool: "subagent_announce", internalEvents: identifiedCompletion() }
            : {}),
        },
      );
      expect(result).toMatchObject({ delivered: false, path: "direct", disposition: outcome });
      expect(callGateway).toHaveBeenCalledOnce();
      if (direct) {
        expect(sendMessage).not.toHaveBeenCalled();
      }
    },
  );

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
      internalEvents: identifiedCompletion(),
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
