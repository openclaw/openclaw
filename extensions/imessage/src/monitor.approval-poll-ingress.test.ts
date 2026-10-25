import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import type { waitForTransportReady } from "openclaw/plugin-sdk/transport-ready-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import type { createIMessageRpcClient } from "./client.js";
import { monitorIMessageProvider } from "./monitor/monitor-provider.js";
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

vi.mock("./approval-reactions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./approval-reactions.js")>()),
  handleIMessageApprovalReaction: vi.fn(async () => ({ handled: false, stopPolling: false })),
}));

vi.mock("./client.js", () => ({
  createIMessageRpcClient: createIMessageRpcClientMock,
}));

vi.mock("./monitor/abort-handler.js", () => ({
  attachIMessageMonitorAbortHandler: vi.fn(() => () => {}),
}));

vi.mock("./monitor/ingress.js", () => ({
  createIMessageDurableIngress: vi.fn(
    (opts: {
      dispatchPriority?: (
        message: unknown,
        lifecycle: unknown,
        receivedAt: number,
        provenance: object,
      ) => Promise<unknown>;
      dispatch: (
        message: unknown,
        lifecycle: unknown,
        receivedAt: number,
        provenance: object,
      ) => Promise<unknown>;
    }) => ({
      receive: async (raw: { message: unknown }) => {
        try {
          const lifecycle = {
            abortSignal: new AbortController().signal,
            ...ingressLifecycleMocks,
          };
          const priorityResult = await opts.dispatchPriority?.(
            raw.message,
            lifecycle,
            Date.now(),
            {},
          );
          const result =
            priorityResult ?? (await opts.dispatch(raw.message, lifecycle, Date.now(), {}));
          if ((result as { kind?: string } | undefined)?.kind === "completed") {
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

function runMonitor(approvalCommand = false) {
  const runtime = createRuntimeSpies();
  return {
    runtime,
    done: monitorIMessageProvider({
      scheduler: createTestPluginServiceScheduler(),
      config: {
        channels: { imessage: approvalCommand ? { dmPolicy: "open", allowFrom: ["*"] } : {} },
      },
      runtime,
    }),
  };
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
    ingressHarness.done = new Promise<void>((resolve) => {
      ingressHarness.resolveDone = () => resolve();
    });
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
                guid: "approval-poll-vote-guid",
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

    await runMonitor().done;

    expect(ingressLifecycleMocks.onAdopted).toHaveBeenCalledTimes(1);
    expect(ingressLifecycleMocks.onAbandoned).not.toHaveBeenCalled();
  });

  it("abandons a claim when approval vote resolution fails transiently", async () => {
    arrangeNotification();
    maybeResolveIMessageApprovalPollVoteMock.mockRejectedValue(new Error("gateway unavailable"));
    const { runtime, done } = runMonitor();
    await done;

    expect(ingressLifecycleMocks.onAdopted).not.toHaveBeenCalled();
    expect(ingressLifecycleMocks.onAbandoned).toHaveBeenCalledTimes(1);
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("gateway unavailable"));
  });

  it("applies the live age fence before resolving an approval vote", async () => {
    arrangeNotification({ created_at: new Date(Date.now() - 60 * 60 * 1_000).toISOString() });
    maybeResolveIMessageApprovalPollVoteMock.mockResolvedValue(true);

    await runMonitor().done;

    expect(maybeResolveIMessageApprovalPollVoteMock).not.toHaveBeenCalled();
    expect(ingressLifecycleMocks.onAdopted).toHaveBeenCalledTimes(1);
  });

  it("routes a valid approval command ahead of the conversation debounce lane", async () => {
    arrangeNotification({
      id: 43,
      guid: "approval-command-guid",
      destination_caller_id: "redacted-agent",
      poll: undefined,
      text: "/approve reject exec-1",
    });
    await runMonitor(true).done;

    expect(runChannelInboundEventMock).toHaveBeenCalledTimes(1);
    expect(ingressLifecycleMocks.onAdopted).toHaveBeenCalledTimes(1);
    expect(ingressLifecycleMocks.onAbandoned).not.toHaveBeenCalled();
  });
});
