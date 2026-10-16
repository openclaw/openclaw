import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import type { waitForTransportReady } from "openclaw/plugin-sdk/transport-ready-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import type { createIMessageRpcClient } from "./client.js";
import { monitorIMessageProvider } from "./monitor.js";
import type { createIMessageDurableIngress } from "./monitor/ingress.js";
import type { IMessagePayload } from "./monitor/types.js";
import { installIMessageStateRuntimeForTest } from "./test-support/runtime.js";

const waitForTransportReadyMock = vi.hoisted(() =>
  vi.fn<typeof waitForTransportReady>(async () => {}),
);
const createIMessageRpcClientMock = vi.hoisted(() => vi.fn<typeof createIMessageRpcClient>());
const maybeResolveIMessageApprovalPollVoteMock = vi.hoisted(() => vi.fn());
const runChannelInboundEventMock = vi.hoisted(() =>
  vi.fn(async () => ({ admission: { kind: "handled", reason: "test" }, dispatched: false })),
);
const ingressLifecycleMocks = vi.hoisted(() => ({
  onAdopted: vi.fn(async () => {}),
  onDeferred: vi.fn(),
  onAdoptionFinalizing: vi.fn(),
  onAbandoned: vi.fn(async () => {}),
}));
const ingressHarness = vi.hoisted(() => ({
  done: Promise.resolve(),
  resolveDone: () => {},
}));

vi.mock("openclaw/plugin-sdk/transport-ready-runtime", () => ({
  waitForTransportReady: waitForTransportReadyMock,
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  return {
    ...actual,
    createChannelInboundDebouncer: vi.fn(() => ({
      debouncer: {
        enqueue: async () => {
          throw new Error("approval vote entered the conversation debounce lane");
        },
      },
    })),
    runChannelInboundEvent: runChannelInboundEventMock,
  };
});

vi.mock("./approval-polls.js", () => ({
  maybeResolveIMessageApprovalPollVote: maybeResolveIMessageApprovalPollVoteMock,
}));

vi.mock("./approval-reaction-poller.js", () => ({
  pollPendingIMessageApprovalReactions: vi.fn(async () => {}),
}));

vi.mock("./approval-reactions.js", () => ({
  maybeResolveIMessageApprovalReaction: vi.fn(async () => false),
}));

vi.mock("./client.js", () => ({
  createIMessageRpcClient: createIMessageRpcClientMock,
}));

vi.mock("./monitor/abort-handler.js", () => ({
  attachIMessageMonitorAbortHandler: vi.fn(() => () => {}),
}));

vi.mock("./monitor/ingress.js", () => ({
  createIMessageDurableIngress: vi.fn(
    (opts: Parameters<typeof createIMessageDurableIngress>[0]) => ({
      receive: async (raw: { message: IMessagePayload }) => {
        try {
          const abortSignal = new AbortController().signal;
          const lifecycle = { abortSignal, ...ingressLifecycleMocks };
          const args = [raw.message, lifecycle, Date.now(), {}] as const;
          const result = (await opts.dispatchPriority?.(...args)) ?? (await opts.dispatch(...args));
          if (result && result.kind === "completed") {
            await ingressLifecycleMocks.onAdopted();
          }
        } catch (error) {
          await ingressLifecycleMocks.onAbandoned();
          throw error;
        } finally {
          ingressHarness.resolveDone();
        }
      },
      start: vi.fn(),
      stop: vi.fn(async () => {}),
    }),
  ),
}));

function runMonitor(imessage = {}, runtime = createRuntimeSpies()) {
  return monitorIMessageProvider({
    scheduler: createTestPluginServiceScheduler(),
    config: { channels: { imessage } },
    runtime,
  });
}

describe("iMessage approval poll durable ingress", () => {
  beforeEach(() => {
    installIMessageStateRuntimeForTest();
    waitForTransportReadyMock.mockReset().mockResolvedValue(undefined);
    createIMessageRpcClientMock.mockReset();
    maybeResolveIMessageApprovalPollVoteMock.mockReset();
    runChannelInboundEventMock.mockClear();
    for (const mock of Object.values(ingressLifecycleMocks)) {
      mock.mockClear();
    }
    const { promise: done, resolve: resolveDone } = Promise.withResolvers<void>();
    Object.assign(ingressHarness, { done, resolveDone });
  });

  function arrangeNotification(overrides: Partial<IMessagePayload> = {}) {
    createIMessageRpcClientMock.mockImplementation(async (params) => {
      return {
        request: vi.fn(async () => ({ subscription: 1 })),
        waitForClose: vi.fn(async () => {
          params?.onNotification?.({
            method: "message",
            params: {
              message: {
                id: 42,
                guid: "approval-ingress-guid",
                chat_id: 7,
                chat_guid: "iMessage;-;redacted-peer",
                chat_identifier: "redacted-peer",
                sender: "redacted-peer",
                is_from_me: false,
                is_group: false,
                created_at: new Date().toISOString(),
                poll: {
                  kind: "vote",
                  original_guid: "approval-poll-guid",
                  vote: { option_id: "approve-once" },
                },
                ...overrides,
              },
            },
          });
          await ingressHarness.done;
        }),
        stop: vi.fn(async () => {}),
      } as never;
    });
  }

  it("completes a handled approval vote instead of abandoning it for replay", async () => {
    arrangeNotification();
    maybeResolveIMessageApprovalPollVoteMock.mockResolvedValue(true);
    await runMonitor();
    expect(ingressLifecycleMocks.onAdopted).toHaveBeenCalledTimes(1);
    expect(ingressLifecycleMocks.onAbandoned).not.toHaveBeenCalled();
  });

  it("abandons a claim when approval vote resolution fails transiently", async () => {
    arrangeNotification();
    maybeResolveIMessageApprovalPollVoteMock.mockRejectedValue(new Error("gateway unavailable"));
    const runtime = createRuntimeSpies();
    await runMonitor({}, runtime);
    expect(ingressLifecycleMocks.onAdopted).not.toHaveBeenCalled();
    expect(ingressLifecycleMocks.onAbandoned).toHaveBeenCalledTimes(1);
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("gateway unavailable"));
  });

  it("applies the live age fence before resolving an approval vote", async () => {
    arrangeNotification({ created_at: new Date(Date.now() - 60 * 60 * 1_000).toISOString() });
    maybeResolveIMessageApprovalPollVoteMock.mockResolvedValue(true);

    await runMonitor();

    expect(maybeResolveIMessageApprovalPollVoteMock).not.toHaveBeenCalled();
    expect(ingressLifecycleMocks.onAdopted).toHaveBeenCalledTimes(1);
  });

  it("routes a valid approval command ahead of the conversation debounce lane", async () => {
    arrangeNotification({
      destination_caller_id: "redacted-agent",
      text: "/approve reject exec-1",
      poll: undefined,
    });
    await runMonitor({ dmPolicy: "open", allowFrom: ["*"] });

    expect(runChannelInboundEventMock).toHaveBeenCalledTimes(1);
    expect(ingressLifecycleMocks.onAdopted).toHaveBeenCalledTimes(1);
    expect(ingressLifecycleMocks.onAbandoned).not.toHaveBeenCalled();
  });
});
