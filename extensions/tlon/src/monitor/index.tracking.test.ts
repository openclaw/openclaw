// Tlon monitor tracking tests exercise bounded state through firehose handlers.
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TLON_PARTICIPATED_THREAD_LIMIT } from "./tracking.js";

const { authenticateMock, connectMock, dispatchReplyMock, eventHandlers, pokeMock } = vi.hoisted(
  () => ({
    authenticateMock: vi.fn(),
    connectMock: vi.fn(),
    dispatchReplyMock: vi.fn(),
    eventHandlers: new Map<string, (event: unknown) => void>(),
    pokeMock: vi.fn(),
  }),
);

vi.mock("../runtime.js", () => ({
  getTlonRuntime: () => ({
    channel: {
      commands: {
        shouldComputeCommandAuthorized: () => false,
      },
      inbound: {
        buildContext: (context: unknown) => context,
        dispatchReply: async (params: {
          ctxPayload: { reply?: { replyToId?: string } };
          delivery: {
            deliver: (payload: { text: string }) => Promise<unknown>;
            onDelivered?: (payload: { text: string }, info: unknown, result: unknown) => void;
          };
        }) => {
          dispatchReplyMock(params.ctxPayload.reply?.replyToId);
          const payload = { text: "tracked thread reply" };
          const result = await params.delivery.deliver(payload);
          params.delivery.onDelivered?.(payload, {}, result);
        },
      },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
        formatAgentEnvelope: ({ body }: { body: string }) => body,
        resolveEffectiveMessagesConfig: () => ({ responsePrefix: "" }),
        resolveHumanDelayConfig: () => undefined,
      },
      routing: {
        resolveAgentRoute: () => ({ accountId: "default", agentId: "main", sessionKey: "test" }),
      },
      session: {
        recordInboundSession: vi.fn(),
        resolveStorePath: () => "test-session-store.json",
      },
    },
    config: {
      current: () => ({
        channels: {
          tlon: {
            autoAcceptDmInvites: true,
            autoAcceptGroupInvites: true,
            code: "code",
            dmAllowlist: ["~allowed"],
            groupChannels: ["chat/~zod/test"],
            groupInviteAllowlist: ["~allowed"],
            ownerShip: "~nec",
            ship: "~zod",
            url: "https://urbit.example.com",
          },
        },
      }),
    },
    logging: {
      getChildLogger: () => ({}),
    },
  }),
}));

vi.mock("../urbit/auth.js", () => ({
  authenticate: authenticateMock,
}));

vi.mock("../urbit/sse-client.js", () => ({
  UrbitSSEClient: class {
    async close() {}
    async connect() {
      connectMock();
    }
    async poke(payload: unknown) {
      return await pokeMock(payload);
    }
    async scry(path: string) {
      return path === "/settings/all.json" ? { all: {} } : {};
    }
    async subscribe(params: { app: string; path: string; event: (event: unknown) => void }) {
      eventHandlers.set(`${params.app}:${params.path}`, params.event);
    }
  },
}));

vi.mock("./utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./utils.js")>();
  return {
    ...actual,
    isDmAllowedWithIngress: vi.fn(async () => true),
    isGroupInviteAllowed: vi.fn(() => true),
  };
});

import { monitorTlonProvider } from "./index.js";

function alphaId(index: number): string {
  let value = index;
  let result = "";
  do {
    result = String.fromCharCode(97 + (value % 26)) + result;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return result;
}

function countPokes(mark: string): number {
  return pokeMock.mock.calls.filter(([payload]) => {
    return (payload as { mark?: string }).mark === mark;
  }).length;
}

function threadEvent(params: { id: string; parentId: string; text: string }) {
  return {
    nest: "chat/~zod/test",
    response: {
      post: {
        "r-post": {
          reply: {
            id: params.id,
            "r-reply": {
              set: {
                memo: {
                  author: "~nec",
                  content: [{ inline: [params.text] }],
                  sent: Date.now(),
                },
                seal: { "parent-id": params.parentId },
              },
            },
          },
        },
      },
    },
  };
}

async function startMonitor() {
  const controller = new AbortController();
  const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() } satisfies RuntimeEnv;
  const monitor = monitorTlonProvider({ abortSignal: controller.signal, runtime });
  await vi.waitFor(() => expect(connectMock).toHaveBeenCalledTimes(1));
  return { controller, monitor, runtime };
}

beforeEach(() => {
  authenticateMock.mockReset().mockResolvedValue("urbauth-~zod=test");
  connectMock.mockReset();
  dispatchReplyMock.mockReset();
  eventHandlers.clear();
  pokeMock.mockReset().mockResolvedValue(undefined);
});

describe("monitorTlonProvider bounded tracking", () => {
  it("responds only for recently retained participated threads after overflow", async () => {
    const { controller, monitor, runtime } = await startMonitor();
    try {
      const channelHandler = eventHandlers.get("channels:/v2");
      expect(channelHandler).toBeDefined();
      for (let index = 0; index <= TLON_PARTICIPATED_THREAD_LIMIT; index += 1) {
        channelHandler?.(
          threadEvent({
            id: `mentioned-${index}`,
            parentId: `parent-${index}`,
            text: "hello ~zod",
          }),
        );
      }
      await vi.waitFor(
        () => expect(dispatchReplyMock).toHaveBeenCalledTimes(TLON_PARTICIPATED_THREAD_LIMIT + 1),
        { timeout: 10_000 },
      );

      dispatchReplyMock.mockClear();
      channelHandler?.(
        threadEvent({ id: "oldest-followup", parentId: "parent-0", text: "old followup" }),
      );
      const recentParentId = `parent-${TLON_PARTICIPATED_THREAD_LIMIT}`;
      channelHandler?.(
        threadEvent({
          id: "recent-followup",
          parentId: recentParentId,
          text: "recent followup",
        }),
      );
      await vi.waitFor(() => expect(dispatchReplyMock).toHaveBeenCalledTimes(1), {
        timeout: 10_000,
      });
      expect(dispatchReplyMock).toHaveBeenCalledWith(recentParentId);
      expect(runtime.error).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      await monitor;
    }
  });

  it("separates a re-added invite from stale in-flight work", async () => {
    const { controller, monitor, runtime } = await startMonitor();
    try {
      const chatHandler = eventHandlers.get("chat:/v3");
      expect(chatHandler).toBeDefined();
      pokeMock.mockClear();
      let releaseOld!: () => void;
      const oldReleased = new Promise<void>((resolve) => {
        releaseOld = resolve;
      });
      let releaseCurrent!: () => void;
      const currentReleased = new Promise<void>((resolve) => {
        releaseCurrent = resolve;
      });
      let dmAttempts = 0;
      pokeMock.mockImplementation(async (payload: { mark?: string }) => {
        if (payload.mark !== "chat-dm-rsvp") {
          return;
        }
        dmAttempts += 1;
        if (dmAttempts === 1) {
          await oldReleased;
          return;
        }
        if (dmAttempts === 2) {
          await currentReleased;
          throw new Error("current RSVP failed");
        }
      });

      const snapshot = [{ ship: "~retryship" }];
      chatHandler?.(snapshot);
      await vi.waitFor(() => expect(dmAttempts).toBe(1));
      chatHandler?.([]);
      chatHandler?.(snapshot);
      await vi.waitFor(() => expect(dmAttempts).toBe(2));

      chatHandler?.(snapshot);
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
      expect(dmAttempts).toBe(2);

      releaseOld();
      await vi.waitFor(() =>
        expect(runtime.log).toHaveBeenCalledWith(
          expect.stringContaining("Auto-accepted DM invite from ~retryship"),
        ),
      );
      expect(dmAttempts).toBe(2);
      chatHandler?.(snapshot);
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
      expect(dmAttempts).toBe(2);

      releaseCurrent();
      await vi.waitFor(() => expect(dmAttempts).toBe(3));
    } finally {
      controller.abort();
      await monitor;
    }
  });

  it("scopes processed DM invites to the active snapshot", async () => {
    const { controller, monitor, runtime } = await startMonitor();
    try {
      const chatHandler = eventHandlers.get("chat:/v3");
      expect(chatHandler).toBeDefined();
      const inviteCount = 2001;
      const invites = Array.from({ length: inviteCount }, (_, index) => ({
        ship: `~${alphaId(index)}`,
      }));
      const newInvite = { ship: "~snapshotnew" };
      const secondNewInvite = { ship: "~snapshotnewer" };

      chatHandler?.(invites);
      await vi.waitFor(() => expect(countPokes("chat-dm-rsvp")).toBe(inviteCount), {
        timeout: 10_000,
      });

      chatHandler?.([...invites, newInvite]);
      await vi.waitFor(() => expect(countPokes("chat-dm-rsvp")).toBe(inviteCount + 1), {
        timeout: 10_000,
      });

      chatHandler?.([...invites.slice(1), newInvite, secondNewInvite]);
      await vi.waitFor(() => expect(countPokes("chat-dm-rsvp")).toBe(inviteCount + 2), {
        timeout: 10_000,
      });

      chatHandler?.([...invites, newInvite, secondNewInvite]);
      await vi.waitFor(() => expect(countPokes("chat-dm-rsvp")).toBe(inviteCount + 3), {
        timeout: 10_000,
      });
      expect(runtime.error).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      await monitor;
    }
  });
});
