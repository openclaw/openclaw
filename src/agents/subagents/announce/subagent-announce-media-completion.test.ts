// Live generated-media completion retains requester authority after produced-byte delivery.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { callGateway as runtimeCallGateway } from "../../../gateway/call.js";
import { sendMessage as runtimeSendMessage } from "../../../infra/outbound/message.js";
import { captureSessionTarget } from "../../../sessions/session-controller.lifecycle.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import {
  expectRecordFields,
  imageCompletionEvents,
  mockCallArg,
  musicCompletionEvents,
} from "../../subagent-test-fixtures.test-helpers.js";
import { testing, deliverSubagentAnnouncement } from "./subagent-announce-delivery.test-support.js";
import type { SubagentAnnounceDeliveryTestDeps } from "./subagent-announce-overrides.test-support.js";

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

function createSendMessageMock() {
  return vi.fn(async () => ({
    channel: "slack",
    to: "channel:C123",
    via: "direct" as const,
    mediaUrl: null,
    result: { messageId: "msg-1" },
  })) as unknown as typeof runtimeSendMessage;
}

function expectGatewayAgentParams(
  callGateway: typeof runtimeCallGateway,
  expected: Record<string, unknown>,
) {
  const request = expectRecordFields(mockCallArg(callGateway), { method: "agent" });
  return expectRecordFields(request.params, expected);
}

const sentDeliveryStatus = { status: "sent", resultCount: 1 } as const;
const deliveredPayload = (text: string) => ({
  result: { payloads: [{ text }], deliveryStatus: sentDeliveryStatus },
});
type AnnouncementInput = Parameters<typeof deliverSubagentAnnouncement>[0];
type DeliveryFixtureParams = Partial<AnnouncementInput> & {
  callGateway: typeof runtimeCallGateway;
  sendMessage?: typeof runtimeSendMessage;
  currentRequesterSessionId?: string | null;
  requesterEntry?: SessionEntry;
};
const deliveryRoutes = {
  discord: {
    key: "agent:main:discord:dm:U123",
    sessionId: "requester-session-dm",
    origin: { channel: "discord", to: "dm:U123", accountId: "acct-1" },
    id: "announce-dm-fallback-empty",
  },
};

async function deliverFixture(
  routeName: keyof typeof deliveryRoutes,
  params: DeliveryFixtureParams,
) {
  const {
    callGateway,
    sendMessage = runtimeSendMessage,
    currentRequesterSessionId,
    requesterEntry,
    ...delivery
  } = params;
  const route = deliveryRoutes[routeName];
  const requesterSessionKey = delivery.requesterSessionKey ?? route.key;
  testing.setDepsForTest({
    callGateway,
    sendMessage,
    getRuntimeConfig: () => ({}),
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
      false,
    ),
  });
  return deliverSubagentAnnouncement({
    triggerMessage: "child done",
    ...delivery,
    requesterSessionKey,
    targetRequesterSessionKey: requesterSessionKey,
    directOrigin: route.origin,
    requesterSessionOrigin: route.origin,
    completionDirectOrigin: delivery.completionDirectOrigin ?? route.origin,
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

describe("live generated-media completion", () => {
  it("delivers a generated-media failure notice through the ordinary input path", async () => {
    const events = musicCompletionEvents({
      status: "error",
      statusLabel: "failed",
      result: "All music generation models failed.",
      mediaUrls: undefined,
    });
    const { result, callGateway, sendMessage } = await runDelivery("discord", {
      sourceTool: "music_generate",
      internalEvents: events,
      response: deliveredPayload("Music generation failed. Please try again."),
    });
    expect(result).toMatchObject({ delivered: true, path: "direct" });
    expectGatewayAgentParams(callGateway, {
      internalEvents: events,
      inputProvenance: expect.objectContaining({ sourceTool: "music_generate" }),
    });
    expect(callGateway).toHaveBeenCalledOnce();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sessionDeliveryQueueMocks.enqueueClaimedSessionDelivery).not.toHaveBeenCalled();
  });

  it.each(["current", "retired", "replaced"] as const)(
    "admits a media completion only after its file receipt with a %s owner",
    async (owner) => {
      let sourceAllowed = true;
      const callGateway = createPayloadGatewayMock({ text: "The image is ready." });
      const sendMessage = createSendMessageMock();
      const params: DeliveryFixtureParams = {
        callGateway,
        sendMessage,
        sourceTool: "image_generate",
        internalEvents: imageCompletionEvents(),
        completionRequesterSessionId: "requester-session-dm",
        completionRequesterLifecycleRevision: "media-lifecycle",
        requesterEntry: {
          sessionId: "requester-session-dm",
          lifecycleRevision: "media-lifecycle",
          updatedAt: 1,
        },
        isSourceSessionAdmissionAllowed: () => sourceAllowed,
        isSourceSessionEffectsAllowed: () => sourceAllowed,
      };
      const pending = await deliverFixture("discord", params);
      expect(pending).toMatchObject({ delivered: false, disposition: "session_queued" });
      expectNoExternalDelivery(callGateway, sendMessage);
      sessionDeliveryQueueMocks.enqueueClaimedSessionDelivery.mockImplementationOnce(() => {
        sourceAllowed = owner !== "retired";
        return { id: "session-delivery-media", claimed: false, status: "completed" };
      });
      const result = await deliverFixture("discord", {
        ...params,
        ...(owner === "replaced" ? { currentRequesterSessionId: "replacement" } : {}),
      });
      expect(result).toMatchObject(
        owner === "current"
          ? { delivered: true, path: "direct" }
          : {
              delivered: false,
              reason:
                owner === "retired" ? "source_owner_changed" : "completion_handoff_unavailable",
            },
      );
      expect(callGateway).toHaveBeenCalledTimes(owner === "current" ? 1 : 0);
      if (owner === "current") {
        expectGatewayAgentParams(callGateway, {
          expectedExistingSessionId: "requester-session-dm",
          inputProvenance: expect.objectContaining({
            kind: "inter_session",
            sourceChannel: "internal",
            sourceTool: "image_generate",
          }),
        });
      }
      expect(sendMessage).not.toHaveBeenCalled();
      expect(sessionDeliveryQueueMocks.scheduleSessionDelivery).toHaveBeenCalledOnce();
    },
  );
});
