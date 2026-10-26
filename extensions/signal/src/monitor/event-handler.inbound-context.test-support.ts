import type { ChannelInboundTurnPlan } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { GetReplyOptions, MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { vi, type Mock } from "vitest";
import type {
  createSignalPreparedDispatchRunner,
  TestDispatchResult,
} from "./event-handler.test-harness.js";

export async function signalInboundTestModule(
  actual: typeof import("openclaw/plugin-sdk/channel-inbound"),
  record: Parameters<typeof createSignalPreparedDispatchRunner>[1],
  dispatch: (plan: ChannelInboundTurnPlan) => Promise<unknown>,
  stubEnvelope = true,
) {
  const { createSignalPreparedDispatchRunner } = await import("./event-handler.test-harness.js");
  return {
    ...actual,
    ...(stubEnvelope
      ? {
          // Scheduling tests must not wait for the session filesystem/worker.
          resolveInboundSessionEnvelopeContextAsync: vi
            .fn<typeof actual.resolveInboundSessionEnvelopeContextAsync>()
            .mockImplementation(async ({ cfg }) => ({
              storePath: "/tmp/openclaw/signal-sessions.json",
              envelopeOptions: actual.resolveEnvelopeFormatOptions(cfg),
              previousTimestamp: undefined,
            })),
        }
      : {}),
    runChannelInboundEvent: createSignalPreparedDispatchRunner(
      actual.runChannelInboundEvent,
      record,
      dispatch,
    ),
  };
}

export function signalConversationTestModule(
  actual: typeof import("openclaw/plugin-sdk/conversation-runtime"),
  record: typeof actual.recordInboundSession,
) {
  return {
    ...actual,
    recordInboundSession: record,
    readChannelAllowFromStore: vi.fn().mockResolvedValue([]),
    upsertChannelPairingRequest: vi.fn(),
  };
}

export type DispatchInboundMessageMockParams = {
  ctx: MsgContext;
  cfg?: OpenClawConfig;
  dispatcher?: {
    sendFinalReply: (payload: { text: string; isError?: boolean }) => void;
    markComplete: () => void;
    waitForIdle: () => Promise<void>;
  };
  replyOptions?: Pick<
    GetReplyOptions,
    | "allowProgressCallbacksWhenSourceDeliverySuppressed"
    | "allowToolLifecycleWhenProgressHidden"
    | "onReplyStart"
    | "onToolStart"
    | "onCompactionStart"
    | "onCompactionEnd"
  >;
};

export function captureNextSignalDispatch(
  mock: Mock<(params: DispatchInboundMessageMockParams) => Promise<TestDispatchResult>>,
): Promise<MsgContext> {
  const dispatched = createDeferred<MsgContext>();
  const dispatch = mock.getMockImplementation()!;
  mock.mockImplementationOnce(async (params) => {
    const result = await dispatch(params);
    dispatched.resolve(params.ctx);
    return result;
  });
  return dispatched.promise;
}
