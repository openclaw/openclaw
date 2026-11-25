import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import type { waitForTransportReady as WaitForReady } from "openclaw/plugin-sdk/transport-ready-runtime";
import { beforeEach, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import type { createIMessageRpcClient } from "./client.js";
import { monitorIMessageProvider } from "./monitor/monitor-provider.js";
import type { IMessagePayload } from "./monitor/types.js";
import { installIMessageStateRuntimeForTest } from "./test-support/runtime.js";

const waitUntilReady = vi.hoisted(() => vi.fn<typeof WaitForReady>(async () => {}));
const createClient = vi.hoisted(() => vi.fn<typeof createIMessageRpcClient>());
const maybeResolveIMessageApprovalPollVoteMock = vi.hoisted(() => vi.fn());
const runChannelInboundEventMock = vi.hoisted(() =>
  vi.fn(async () => ({ admission: { kind: "handled", reason: "test" }, dispatched: false })),
);
const ingressHarness = vi.hoisted(() => ({
  done: Promise.resolve(),
  resolveDone: () => {},
  results: [] as unknown[],
}));
type Dispatch = (...args: [unknown, unknown, number, object]) => Promise<unknown>;

// mock-isolation: Readiness is fixture-controlled; no installed Messages transport is probed.
vi.mock("openclaw/plugin-sdk/transport-ready-runtime", () => ({
  waitForTransportReady: waitUntilReady,
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

// mock-isolation: The monitor connects only to the fixture RPC client, never the user's Messages store.
vi.mock("./client.js", () => ({ createIMessageRpcClient: createClient }));

vi.mock("./monitor/abort-handler.js", () => ({
  attachIMessageMonitorAbortHandler: vi.fn(() => () => {}),
}));

// mock-isolation: This fixture owns ingress claims and records priority dispatch without a live queue.
vi.mock("./monitor/ingress.js", () => ({
  createIMessageDurableIngress: vi.fn(
    (opts: { dispatchPriority?: Dispatch; dispatch: Dispatch }) => ({
      receive: async (raw: { message: unknown }) => {
        try {
          const lifecycle = { abortSignal: new AbortController().signal };
          const priorityResult = await opts.dispatchPriority?.(
            raw.message,
            lifecycle,
            Date.now(),
            {},
          );
          const result =
            priorityResult ?? (await opts.dispatch(raw.message, lifecycle, Date.now(), {}));
          ingressHarness.results.push(result);
        } catch (error) {
          ingressHarness.results.push(error);
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

beforeEach(() => {
  installIMessageStateRuntimeForTest();
  waitUntilReady.mockReset().mockResolvedValue(undefined);
  createClient.mockReset();
  maybeResolveIMessageApprovalPollVoteMock.mockReset();
  runChannelInboundEventMock.mockClear();
  ingressHarness.results = [];
  ingressHarness.done = new Promise<void>((resolve) => {
    ingressHarness.resolveDone = () => resolve();
  });
});

function arrangeNotification(overrides: Partial<IMessagePayload> = {}) {
  createClient.mockImplementation(async (params) => {
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

it.each(["vote", "transient failure", "stale vote", "command"])(
  "settles approval ingress: %s",
  async (kind) => {
    const failed = kind === "transient failure";
    const command = kind === "command";
    arrangeNotification(
      command
        ? {
            destination_caller_id: "redacted-agent",
            poll: undefined,
            text: "/approve reject exec-1",
          }
        : kind === "stale vote"
          ? { created_at: new Date(Date.now() - 60 * 60 * 1_000).toISOString() }
          : {},
    );
    if (failed) {
      maybeResolveIMessageApprovalPollVoteMock.mockRejectedValue(new Error("gateway unavailable"));
    } else {
      maybeResolveIMessageApprovalPollVoteMock.mockResolvedValue(!command);
    }
    const runtime = createRuntimeSpies();
    await monitorIMessageProvider({
      scheduler: createTestPluginServiceScheduler(),
      runtime,
      config: { channels: { imessage: command ? { dmPolicy: "open", allowFrom: ["*"] } : {} } },
    });
    expect(ingressHarness.results).toEqual([failed ? expect.any(Error) : { kind: "completed" }]);
    if (failed) {
      expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("gateway unavailable"));
    } else if (command) {
      expect(runChannelInboundEventMock).toHaveBeenCalledOnce();
    } else if (kind === "stale vote") {
      expect(maybeResolveIMessageApprovalPollVoteMock).not.toHaveBeenCalled();
    }
  },
);
