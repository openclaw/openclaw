// Googlechat tests cover the monitor's live typing status lifecycle.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { GoogleChatApiError } from "./api.js";
import type { GoogleChatCoreRuntime } from "./monitor-types.js";
import "./monitor.js";
import type { GoogleChatEvent } from "./types.js";

const apiMocks = vi.hoisted(() => ({
  deleteGoogleChatMessage: vi.fn(),
  sendGoogleChatMessage: vi.fn(),
  updateGoogleChatMessage: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  applyGoogleChatInboundAccessPolicy: vi.fn(),
  resolveChannelInboundRouteEnvelope: vi.fn(),
  processEvent: undefined as
    | ((event: GoogleChatEvent, target: Record<string, unknown>) => Promise<void>)
    | undefined,
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>()),
  resolveChannelInboundRouteEnvelope: mocks.resolveChannelInboundRouteEnvelope,
}));

vi.mock("./api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api.js")>()),
  ...apiMocks,
}));

vi.mock("./monitor-access.js", () => ({
  applyGoogleChatInboundAccessPolicy: mocks.applyGoogleChatInboundAccessPolicy,
}));

vi.mock("./monitor-routing.js", () => ({
  registerGoogleChatWebhookTarget: vi.fn(),
  setGoogleChatWebhookEventProcessor: vi.fn((processEvent: typeof mocks.processEvent) => {
    mocks.processEvent = processEvent;
  }),
}));

beforeEach(() => {
  apiMocks.deleteGoogleChatMessage.mockReset();
  apiMocks.sendGoogleChatMessage.mockReset().mockResolvedValue(null);
  apiMocks.updateGoogleChatMessage.mockReset().mockResolvedValue({});
  mocks.applyGoogleChatInboundAccessPolicy.mockReset().mockResolvedValue({
    ok: true,
    commandAuthorized: undefined,
    effectiveWasMentioned: undefined,
    groupBotLoopProtection: undefined,
    groupSystemPrompt: undefined,
  });
  mocks.resolveChannelInboundRouteEnvelope
    .mockReset()
    .mockImplementation(({ accountId }: { accountId: string }) => ({
      route: { agentId: "agent-1", accountId, sessionKey: "session-1" },
      buildEnvelope: ({ body }: { body: string }) => body,
    }));
});

type LiveTurn = {
  delivery: {
    deliver: (
      payload: { text: string; replyToId?: string },
      info?: { kind: string },
    ) => Promise<void>;
  };
  replyOptions?: {
    onToolStart?: (payload: {
      toolCallId?: string;
      name?: string;
      phase?: string;
      args?: Record<string, unknown>;
    }) => unknown;
    onQueuedFollowupAdmitted?: () => Promise<void>;
    onQueuedFollowupSettled?: () => Promise<void>;
  };
};

const placeholder = "spaces/LIVE/messages/typing";
const typingText = "_OpenClaw is typing..._";
const doneStatus = "_OpenClaw is done — reply below._";

async function runLiveTurn(params: { drive?: (turn: LiveTurn) => Promise<void>; thread?: string }) {
  if (!mocks.processEvent) {
    throw new Error("Expected Google Chat webhook event processor registration");
  }
  let retained: LiveTurn | undefined;
  const runTurn = vi.fn(async (runParams: { adapter: { resolveTurn: () => LiveTurn } }) => {
    retained = runParams.adapter.resolveTurn();
    await params.drive?.(retained);
  });
  const core = {
    logging: { shouldLogVerbose: () => false },
    channel: {
      inbound: { buildContext: vi.fn((payload: unknown) => payload), run: runTurn },
      text: {
        resolveChunkMode: vi.fn(() => "markdown"),
        chunkMarkdownTextWithMode: vi.fn((text: string) => [text]),
      },
    },
  } as unknown as GoogleChatCoreRuntime;
  const account = {
    accountId: "work",
    config: { typingIndicator: "live", ...(params.thread ? { replyToMode: "all" } : {}) },
    credentialSource: "inline",
  } as ResolvedGoogleChatAccount;

  await mocks.processEvent(
    {
      type: "MESSAGE",
      space: { name: "spaces/LIVE", spaceType: "SPACE" },
      message: {
        name: "spaces/LIVE/messages/1",
        text: "hello",
        ...(params.thread ? { thread: { name: params.thread } } : {}),
        sender: { name: "users/alice", displayName: "Alice", type: "HUMAN" },
      },
    },
    {
      account,
      config: {},
      runtime: { error: vi.fn(), log: vi.fn() },
      core,
      mediaMaxMb: 10,
      path: "/googlechat",
    },
  );
  if (!retained) {
    throw new Error("Expected the live turn to run");
  }
  return { account, turn: retained };
}

describe("googlechat monitor live typing mode", () => {
  it.each([
    {
      name: "core routes the queued answer",
      deliverThroughMonitor: false,
      expectedSent: [typingText],
      expectedDone: [],
      expectedDeleted: [placeholder],
    },
    {
      name: "the monitor delivers the queued answer",
      deliverThroughMonitor: true,
      expectedSent: [typingText, "queued answer"],
      expectedDone: [placeholder],
      expectedDeleted: [],
    },
  ])(
    "reuses and retires the queued message's placeholder when $name",
    async ({ deliverThroughMonitor, expectedSent, expectedDone, expectedDeleted }) => {
      apiMocks.sendGoogleChatMessage.mockResolvedValue({ messageName: placeholder });
      // The run is queued behind an active one, so it returns without delivering;
      // core later drains the queued turn through the retained callbacks.
      const { turn } = await runLiveTurn({});

      await turn.replyOptions?.onQueuedFollowupAdmitted?.();
      if (deliverThroughMonitor) {
        await turn.delivery.deliver({ text: "queued answer" }, { kind: "final" });
      }
      await turn.replyOptions?.onQueuedFollowupSettled?.();

      expect(apiMocks.sendGoogleChatMessage.mock.calls.map(([call]) => call.text)).toEqual(
        expectedSent,
      );
      const doneEdits = apiMocks.updateGoogleChatMessage.mock.calls
        .filter(([call]) => call.text === doneStatus)
        .map(([call]) => call.messageName);
      expect(doneEdits).toEqual(expectedDone);
      expect(apiMocks.deleteGoogleChatMessage.mock.calls.map(([call]) => call.messageName)).toEqual(
        expectedDeleted,
      );
    },
  );

  it("follows a re-sent live placeholder into its new thread for the done status and answer", async () => {
    const requestedThread = "spaces/LIVE/threads/root";
    const replacement = "spaces/LIVE/messages/replacement";
    const replacementThread = "spaces/LIVE/threads/replacement";
    apiMocks.sendGoogleChatMessage
      .mockResolvedValueOnce({ messageName: placeholder, threadName: requestedThread })
      .mockResolvedValueOnce({ messageName: replacement, threadName: replacementThread })
      .mockResolvedValueOnce({ messageName: "spaces/LIVE/messages/answer" });
    apiMocks.updateGoogleChatMessage.mockRejectedValueOnce(
      new GoogleChatApiError(404, "Google Chat API 404: message not found"),
    );
    vi.useFakeTimers();
    try {
      const { account } = await runLiveTurn({
        thread: requestedThread,
        drive: async (turn) => {
          await turn.replyOptions?.onToolStart?.({
            toolCallId: "call-1",
            name: "exec",
            phase: "start",
            args: { command: "ls" },
          });
          // Let the progress draft pass its startup delay so the first edit lands.
          await vi.advanceTimersByTimeAsync(2_000);
          await turn.delivery.deliver(
            { text: "the answer", replyToId: requestedThread },
            { kind: "final" },
          );
        },
      });

      expect(apiMocks.updateGoogleChatMessage).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ account, messageName: placeholder }),
      );
      expect(apiMocks.updateGoogleChatMessage).toHaveBeenLastCalledWith({
        account,
        messageName: replacement,
        text: doneStatus,
      });
      expect(apiMocks.sendGoogleChatMessage).toHaveBeenLastCalledWith({
        account,
        space: "spaces/LIVE",
        text: "the answer",
        thread: replacementThread,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
