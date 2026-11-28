// Subagent announce delivery tests cover the last-mile routing used when child
// runs report progress or completion back to the requester session.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateAgentParams } from "../../../../packages/gateway-protocol/src/index.js";
import { formatValidationErrors } from "../../../../packages/gateway-protocol/src/validation-errors.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { InternalAgentTurnDispatchOptions } from "../../../gateway/agent-turn/internal-facade.types.js";
import type { callGateway as runtimeCallGateway } from "../../../gateway/call.js";
import { parseMessageWithAttachments } from "../../../gateway/chat-attachments.js";
import { authorizeGatewaySessionCreation } from "../../../gateway/operator-role-policy.js";
import { waitForGatewayDispatch } from "../../../gateway/server-in-process-dispatch.js";
import type { dispatchGatewayMethodInProcess as runtimeDispatchGatewayMethodInProcess } from "../../../gateway/server-plugins.js";
import { sendMessage as runtimeSendMessage } from "../../../infra/outbound/message.js";
import { saveMediaBuffer } from "../../../media/store.js";
import { createTestInstance } from "../../../plugins/plugin-instance.test-support.js";
import { PluginInvocationScope } from "../../../plugins/plugin-invocation-scope.js";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import { captureSessionTarget } from "../../../sessions/session-controller.lifecycle.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../../test-utils/channel-plugins.js";
import { detectAndLoadPromptImages } from "../../embedded-agent-runner/run/images.js";
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
import { buildSavedMediaAttachment } from "../../tools/media-generate-result-shared.js";
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

const mediaTempDirs = useAutoCleanupTempDirTracker(afterEach);
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
          expect(await delivery).toMatchObject({ delivered: false });
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
const identifiedCompletion = (overrides: Parameters<typeof taskCompletionEvents>[0] = {}) =>
  taskCompletionEvents({ childSessionId: "child-session-id", ...overrides });
const messageToolConfig = { messages: { groupChat: { visibleReplies: "message_tool" as const } } };
const responseWithResult = (result: Record<string, unknown>) => ({ result });

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

function createPayloadGatewayMock(...payloads: Record<string, unknown>[]) {
  return createGatewayMock({
    result: { payloads, ...(payloads.length > 0 ? { deliveryStatus: sentDeliveryStatus } : {}) },
  });
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

function registerDirectTargetTestChannel(channelId: string) {
  const instance = createTestInstance(channelId);
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
            inferTargetChatType: instance.wrap(({ to }: { to: string }) =>
              to.startsWith("channel:") || to.startsWith("thread:") ? "channel" : "direct",
            ),
          },
        },
      },
    ]),
  );
  return instance;
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
  expect(mockCallArg(dispatchGatewayMethodInProcess, 0, 0)).toBe("agent");
  return expectRecordFields(mockCallArg(dispatchGatewayMethodInProcess, 0, 1), expected);
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
    sessionId,
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
        : (currentRequesterSessionId ?? sessionId ?? route.sessionId),
      isActive === true,
    ),
    ...(routeName === "thread" || routeName === "telegram"
      ? { resolveRequesterSessionAbandonment: () => requesterAbandonment }
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

async function runDelivery(
  route: keyof typeof deliveryRoutes,
  {
    response,
    ...params
  }: Partial<DeliveryFixtureParams> & { response?: Record<string, unknown> | Error } = {},
) {
  const callGateway =
    params.callGateway ??
    (response === undefined ? createPayloadGatewayMock() : createGatewayMock(response));
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
  type DeliveryCase = {
    name: string;
    route: keyof typeof deliveryRoutes;
    response?: Record<string, unknown>;
    params?: Partial<DeliveryFixtureParams>;
    expected?: Record<string, unknown>;
    sent?: Record<string, unknown>;
    gateway?: Record<string, unknown>;
    gatewayCalls?: number;
    setup?: () => void;
  };
  const deliveredPayload = (text: string) => ({
    result: { payloads: [{ text }], deliveryStatus: sentDeliveryStatus },
  });
  const completionCase = (
    name: string,
    route: DeliveryCase["route"],
    fields: Omit<DeliveryCase, "name" | "route">,
  ): DeliveryCase => ({ name, route, ...fields });
  it.each<DeliveryCase>([
    completionCase("yield custody", "thread", {
      params: {
        sessionId: "requester-session-1",
        isActive: true,
        internalEvents: undefined,
        isCompletionOwnedByRequesterYield: () => true,
      },
      expected: {
        delivered: false,
        path: "none",
        reason: "completion_handoff_pending",
      },
      gatewayCalls: 0,
    }),
    completionCase("cron run holding its turn after its attempt ended", "thread", {
      params: { requesterSessionKey: "agent:main:cron:job:run:run-1", isActive: true },
      expected: { delivered: false, path: "none", reason: "completion_handoff_pending" },
      gatewayCalls: 0,
    }),
    completionCase("omitted synthesis result", "discord", {
      response: { result: { payloads: [{ text: "TG88042_NO_REOUTPUT" }] } },
      params: {
        internalEvents: identifiedCompletion({ result: "The child found the root cause." }),
      },
      sent: {
        channel: "discord",
        accountId: "acct-1",
        to: "dm:U123",
        content: "The child found the root cause.",
        idempotencyKey: "announce-dm-fallback-empty:text-direct",
      },
    }),
    completionCase("bare requester owner", "discord", {
      params: {
        requesterSessionKey: "global",
        requesterAgentId: "research",
        runtimeConfig: {
          session: { scope: "global" },
          agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
        },
      },
      sent: {
        requesterSessionKey: "global",
        agentId: "research",
        session: { agentId: "research", policyKey: "global" },
      },
    }),
    completionCase("channel-grammar direct target", "channel", {
      setup: () => registerDirectTargetTestChannel("qa-channel"),
      params: {
        sessionId: "requester-session-qa",
        directIdempotencyKey: "announce-qa-fallback-empty",
        requesterSessionKey: "agent:qa:subagent-direct-fallback:1234",
        requesterOrigin: { channel: "qa-channel", to: "qa-operator", accountId: "default" },
      },
      sent: {
        channel: "qa-channel",
        accountId: "default",
        to: "qa-operator",
        content: "child completion output",
        idempotencyKey: "announce-qa-fallback-empty:text-direct",
      },
    }),
    completionCase("visible but failed delivery", "thread", {
      response: responseWithResult({
        payloads: [{ text: "Tests passed and the PR is ready for review." }],
        deliveryStatus: {
          status: "failed",
          errorMessage: "Slack send failed: channel not found",
        },
      }),
      expected: { delivered: false, path: "direct", error: "Slack send failed: channel not found" },
    }),
    completionCase("abandoned requester", "telegram", {
      params: { requesterAbandonment: "timeout", isActive: false },
      expected: {
        delivered: false,
        path: "none",
        reason: "requester_abandoned",
        error: "requester session abandoned after timeout",
      },
      gatewayCalls: 0,
    }),
    completionCase("Telegram forum topic", "telegram", {
      response: deliveredPayload("The delegated task is complete."),
      params: {
        requesterSessionKey: "agent:main:telegram:group:-1003871627242:topic:6823",
        origin: {
          channel: "telegram",
          to: "telegram:-1003871627242",
          accountId: "bot-1",
          threadId: 6823,
        },
        sourceTool: "subagent_announce",
        internalEvents: identifiedCompletion({
          childSessionKey: "agent:codex:subagent:child",
          result: "delegated task output",
        }),
      },
      gatewayCalls: 1,
      gateway: {
        deliver: true,
        channel: "telegram",
        accountId: "bot-1",
        to: "telegram:-1003871627242",
        threadId: "6823",
      },
    }),
    completionCase("committed tool final after error", "discord", {
      response: responseWithResult({
        payloads: [],
        deliveryStatus: { status: "failed", errorMessage: "Agent couldn't generate a response." },
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
      }),
      params: {
        sourceTool: "subagent_announce",
        internalEvents: identifiedCompletion({ result: "(no output)", noVisibleResult: true }),
      },
    }),
    completionCase("internal completion origin", "channel", {
      response: deliveredPayload("child completion output"),
      params: { completionDirectOrigin: { channel: "webchat" } },
    }),
  ])("$name", async ({ route, response, params, expected, sent, gateway, gatewayCalls, setup }) => {
    setup?.();
    const callGateway = createGatewayMock(response ?? { result: { payloads: [] } });
    const sendMessage = createSendMessageMock();
    const result = await deliverFixture(route, {
      callGateway,
      sendMessage,
      internalEvents: identifiedCompletion(),
      ...params,
    });
    expectRecordFields(result, expected ?? { delivered: true, path: "direct" });
    if (sent) {
      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining(sent));
    } else {
      expect(sendMessage).not.toHaveBeenCalled();
    }
    if (gateway) {
      expectGatewayAgentParams(callGateway, gateway);
    }
    if (gatewayCalls !== undefined) {
      expect(callGateway).toHaveBeenCalledTimes(gatewayCalls);
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
      expected: { path: "queued", reason: "requester_turn_pending" },
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
    "hands a private completion only to a live parent chat, also after a reset: %s",
    async (currentRequesterSessionId) => {
      const { result, callGateway, sendMessage } = await runDelivery("discord", {
        response: { status: "ok", inputProcessingCompleted: true, result: { payloads: [] } },
        completionTarget: "parent",
        currentRequesterSessionId,
        internalEvents: taskCompletionEvents(),
      });
      if (currentRequesterSessionId) {
        expectGatewayAgentParams(callGateway, { expectedExistingSessionId: "replacement-parent" });
        return expect(sendMessage).not.toHaveBeenCalled();
      }
      expect(result).toMatchObject({ delivered: false, reason: "completion_handoff_unavailable" });
      expectNoExternalDelivery(callGateway, sendMessage);
    },
  );

  it.each([
    {
      name: "intentional suppression",
      suppressionReason: "cancelled_by_message_sending_hook",
      reason: "delivery_suppressed",
    },
    {
      name: "adapter ambiguity",
      suppressionReason: "adapter_returned_no_identity",
      reason: "delivery_suppressed",
    },
  ] as const)("reports $name from direct text completion fallback", async (testCase) => {
    const onDeliveryResult = vi.fn();
    const sendMessage = vi.fn(async () => ({
      channel: "discord",
      to: "dm:U123",
      via: "direct" as const,
      mediaUrl: null,
      deliveryStatus: "suppressed" as const,
      suppressionReason: testCase.suppressionReason,
    })) as unknown as typeof runtimeSendMessage;

    const { result } = await runDelivery("discord", {
      sendMessage,
      internalEvents: identifiedCompletion(),
      onDeliveryResult,
    });

    expectRecordFields(result, {
      delivered: false,
      path: "direct",
      reason: testCase.reason,
    });
    expect(onDeliveryResult).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

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

  it("admits only the delivered generation as image input without widening workspace discovery", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", mediaTempDirs.make("openclaw-generated-inspection-"));
    try {
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=",
        "base64",
      );
      const generated = await saveMediaBuffer(png, "image/png", "tool-image-generation");
      const unrelated = await saveMediaBuffer(png, "image/png", "tool-image-generation");
      sessionDeliveryQueueMocks.enqueueClaimedSessionDelivery.mockReturnValueOnce({
        id: "session-delivery-media",
        claimed: false,
        status: "completed",
      });
      const { callGateway, sendMessage } = await runDelivery("discord", {
        sourceTool: "image_generate",
        inputAttachments: [
          { type: "image", mimeType: "image/png", content: png.toString("base64") },
        ],
        internalEvents: imageCompletionEvents({
          mediaUrls: [generated.path],
          attachments: [buildSavedMediaAttachment("image", generated)],
        }),
      });
      const request = mockCallArg(callGateway);
      const input = request.params;
      if (!input || typeof input !== "object") {
        throw new Error("Expected completion agent input");
      }
      const attachments = Reflect.get(input, "attachments");
      expect(attachments).toEqual([
        expect.objectContaining({ mimeType: "image/png", content: png.toString("base64") }),
      ]);
      const parsed = await parseMessageWithAttachments("Review the generated image", attachments);
      const prepared = await detectAndLoadPromptImages({
        prompt: `Inspect ${unrelated.path}`,
        workspaceDir: mediaTempDirs.make("openclaw-inspection-workspace-"),
        workspaceOnly: true,
        model: { input: ["text", "image"] },
        existingImages: parsed.images,
        media: parsed.media,
        imageOrder: parsed.imageOrder,
      });
      expect(prepared.images).toHaveLength(1);
      expect(prepared.skippedCount).toBe(1);
      expect(sendMessage).not.toHaveBeenCalled();
      expect(input).toMatchObject({
        internalEvents: [{ mediaUrls: undefined, attachments: undefined }],
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  registerDescendantWakeCurrencyTests({
    createRoleRestrictedInProcessGatewayMock,
    createGatewayMock,
    runDescendantWake,
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
  }>([
    {
      name: "private generated media on the owning session agent loop",
      route: "private",
      sourceTool: "image_generate",
      options: {
        requesterIsSubagent: true,
        requesterEntry: {
          sessionId: "requester-subagent-session",
          updatedAt: 1,
          chatType: "channel",
        },
        runtimeConfig: messageToolConfig,
      },
      events: imageCompletionEvents({
        taskLabel: "private proof image",
        result: "Generated 1 image.\nMEDIA:/tmp/generated-private.png",
        mediaUrls: ["/tmp/generated-private.png"],
        replyInstruction: "Tell the user the image is ready and include the generated media.",
      }),
      expected: {
        route: { channel: "webchat", to: "agent:worker:subagent:parent", chatType: "direct" },
        sourceReplyDeliveryMode: "automatic",
      },
    },
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
        runtimeConfig: messageToolConfig,
        preparedRequester: {
          binding: {
            agentId: "main",
            sessionKey: "agent:main:slack:channel:C123",
            storePath: "/synthetic/media/sessions.db",
            sessionId: "requester-session-channel",
            lifecycleRevision: null,
          },
          entry: { sessionId: "requester-session-channel", updatedAt: 1 },
        },
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
        messageId: "announce-channel-media-handoff-locked:agent-loop",
        route: { channel: "slack", to: "channel:C123", accountId: "acct-1", chatType: "channel" },
        inputProvenance: {
          kind: "inter_session",
          sourceChannel: "internal",
          sourceTool: "image_generate",
        },
        sourceReplyDeliveryMode: "message_tool_only",
        expectedMediaUrls: ["/tmp/generated-locked.png"],
        requesterBinding: {
          agentId: "main",
          sessionKey: "agent:main:slack:channel:C123",
          storePath: "/synthetic/media/sessions.db",
          sessionId: "requester-session-channel",
          lifecycleRevision: null,
        },
        idempotencyKey: "announce-channel-media-handoff-locked:agent-loop",
      },
    },
  ])("queues $name", async ({ route, sourceTool, events, options, expected }) => {
    const { result, callGateway, sendMessage } = await runDelivery(route, {
      sourceTool,
      internalEvents: events,
      ...options,
    });

    expectDeliveryPath(result, "queued");
    expectNoExternalDelivery(callGateway, sendMessage);
    expect(sessionDeliveryQueueMocks.enqueueClaimedSessionDelivery).toHaveBeenCalledWith(
      expect.objectContaining(expected),
      expect.any(Number),
      expectQueueContext(),
    );
    expect(sessionDeliveryQueueMocks.releaseSessionDeliveryClaim).toHaveBeenCalledWith(
      "session-delivery-media",
      expectQueueContext(),
    );
    expect(sessionDeliveryQueueMocks.scheduleSessionDelivery).toHaveBeenCalledWith(
      "session-delivery-media",
      expectQueueContext(),
    );
  });

  it.each(["unavailable", "failed"] as const)(
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

      expectRecordFields(result, {
        delivered: false,
        path: "none",
        reason: "completion_handoff_unavailable",
      });
      expect(callGateway).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();
      if (status !== "unavailable") {
        expect(sessionDeliveryQueueMocks.scheduleSessionDelivery).not.toHaveBeenCalled();
      }
    },
  );

  it("keeps channel completion parameters valid for a silent requester response", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [],
        meta: { terminalReply: { disposition: "silent" } },
        deliveryStatus: sentDeliveryStatus,
      },
    });
    const childSessionKey = "agent:worker:subagent:no-output";
    const result = await deliverFixture("channel", {
      callGateway,
      directIdempotencyKey: "announce-channel-no-output",
      sourceTool: "subagent_announce",
      sourceSessionKey: childSessionKey,
      runtimeConfig: messageToolConfig,
      internalEvents: taskCompletionEvents({
        childSessionKey,
        childSessionId: "child-session-id",
        result: "(no output)",
        noVisibleResult: undefined,
      }),
    });
    expectRecordFields(result, { delivered: true, path: "direct" });
    const request = expectRecordFields(mockCallArg(callGateway), { method: "agent" });
    const isValid = validateAgentParams(request.params);
    expect(isValid ? "" : formatValidationErrors(validateAgentParams.errors)).toBe("");
  });

  it.each(["accepted", "in_flight", "yielded"] as const)(
    "does not replay a still-owned %s completion handoff",
    async (state) => {
      const callGateway = createGatewayMock(
        state === "yielded"
          ? { status: "ok", result: { payloads: [], meta: { yielded: true } } }
          : { status: state },
      );
      const result = await deliverFixture("channel", {
        callGateway,
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
              path: "queued",
            }
          : { delivered: true, path: "direct" },
      );
      expect(callGateway).toHaveBeenCalledTimes(1);
    },
  );

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
    ["legacy targetless delivery", { provider: "message" }, false],
    ["wrong recipient", otherTarget, true],
    ["targetless wrong provider", { provider: "slack" }, true],
    ["wrong account", { ...requesterTarget, accountId: "acct-other" }, true],
    [
      "authoritative source receipt",
      otherTarget,
      false,
      { didDeliverSourceReplyViaMessageTool: true },
    ],
    [
      "targetless source media",
      { ...otherTarget, mediaUrls: ["/tmp/unrelated.mp3"] },
      false,
      { messagingToolSentMediaUrls: ["/tmp/current-source.mp3"] },
    ],
    [
      "off-target attachment",
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
    const result = await deliverFixture("discord", {
      callGateway,
      sendMessage,
      sourceTool: "subagent_announce",
      internalEvents: identifiedCompletion(),
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

  const undeliveredCompletion = { delivered: false };
  const suppressedCompletionReceipt = (reasons: string[]) => ({
    status: "suppressed",
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
      expected: { ...undeliveredCompletion, finalAssistantVisibleText: "" },
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
        reason: "delivery_suppressed",
        error: "cancelled_by_message_sending_hook",
      },
    },
    {
      name: "unidentified adapter before a later failure",
      payloads: [{ text: "Unidentified completion" }, { text: "Failed supplement" }],
      deliveryStatus: {
        status: "failed",
        errorMessage: "supplement failed",
        payloadOutcomes: [
          { index: 0, status: "suppressed", reason: "adapter_returned_no_identity" },
          {
            index: 1,
            status: "failed",
            error: "supplement failed",
          },
        ],
      },
      expected: undeliveredCompletion,
    },
    {
      name: "partial send without per-payload details",
      deliveryStatus: {
        status: "partial_failed",
        resultCount: 1,
        sentBeforeError: true,
        errorMessage: "supplement failed",
      },
      expected: undeliveredCompletion,
    },
  ])("does not credit a $name automatic completion receipt", async (testCase) => {
    const { deliveryStatus, expected } = testCase;
    const callGateway = createGatewayMock({
      status: "ok",
      result: {
        payloads: "payloads" in testCase ? testCase.payloads : [{ text: "Generated completion" }],
        deliveryStatus,
      },
    });
    const result = await deliverFixture("thread", {
      callGateway,
      directIdempotencyKey: "announce-undelivered-receipt",
    });

    expect(result).toMatchObject(expected);
    expect(result.requesterVisibleFinalDelivered).toBeUndefined();
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

  it("routes a completion after the finished child's plugin scope closes", async () => {
    const scope = new PluginInvocationScope(createTestRegistry(), [
      registerDirectTargetTestChannel("telegram"),
    ]);
    const delivery = scope.run(async () => {
      await Promise.resolve();
      return runDelivery("telegram", { internalEvents: identifiedCompletion() });
    });
    scope.release();
    const { result, sendMessage } = await delivery;
    expect(result).toMatchObject({ delivered: true, path: "direct" });
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it("does not text-fallback when source ownership changes during the Gateway attempt", async () => {
    let sourceEffectsAllowed = true;
    const callGateway = createGatewayMock({}, () => {
      sourceEffectsAllowed = false;
      throw new Error("incomplete terminal response code=incomplete_result");
    });
    const sendMessage = createSendMessageMock();
    const result = await deliverFixture("discord", {
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
    });
    expect(callGateway).toHaveBeenCalledOnce();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
