import type { PreparedInboundReply } from "openclaw/plugin-sdk/channel-inbound";
import { createReplyDispatcher, dispatchInboundMessage } from "openclaw/plugin-sdk/reply-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../runtime-api.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import "./message-handler-mock-support.test-support.js";
import { createMSTeamsMessageHandler } from "./message-handler.js";
import { createMessageHandlerDeps, createTurnContext } from "./message-handler.test-support.js";

const chatId = "19:Room-A@thread.v2";

type Turn = { agentId: string | undefined; sessionKey: string | undefined };

// Runs real Teams inbound preparation, then real core dispatch (including the
// broadcast group-thread fan-out); only the agent reply is stubbed.
async function sendGroupMessage(broadcast?: OpenClawConfig["broadcast"]) {
  const cfg: OpenClawConfig = {
    agents: { entries: { main: {}, helper: {} } },
    bindings: [{ agentId: "main", match: { channel: "msteams" } }],
    channels: { msteams: { groupPolicy: "open", requireMention: false } },
    ...(broadcast ? { broadcast } : {}),
  };
  const turns: Turn[] = [];
  const runPrepared = vi.fn(async (turn: PreparedInboundReply<unknown>) => {
    const dispatcher = createReplyDispatcher({ deliver: async () => undefined });
    await dispatchInboundMessage({
      ctx: turn.ctxPayload,
      cfg,
      dispatcher,
      dispatchReplyFromConfig: async ({ ctx }) => {
        turns.push({ agentId: ctx.AgentId, sessionKey: ctx.SessionKey });
        return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
      },
    });
    return {
      admission: { kind: "dispatch" as const },
      dispatched: true,
      ctxPayload: turn.ctxPayload,
      routeSessionKey: turn.routeSessionKey,
    };
  });
  const { deps } = createMessageHandlerDeps(cfg, {
    resolveAgentRoute: (params) =>
      resolveAgentRoute({ ...params, cfg } as Parameters<typeof resolveAgentRoute>[0]),
    runPrepared: runPrepared as never,
  });
  const handler = createMSTeamsMessageHandler(deps);
  await handler(
    createTurnContext({
      id: `msg-${turns.length}-${Math.random()}`,
      type: "message",
      text: "hello room",
      from: { id: "user-id", aadObjectId: "user-aad", name: "Test User" },
      recipient: { id: "bot-id", name: "Bot" },
      conversation: { id: chatId, conversationType: "groupChat" },
      channelData: {},
      entities: [],
    } as never),
  );
  expect(runPrepared).toHaveBeenCalledTimes(1);
  return { turns, ctx: runPrepared.mock.calls[0]?.[0].ctxPayload };
}

describe("Teams group chat broadcast routing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the routed agent's session when a documented broadcast entry is added or removed", async () => {
    const ordinary = await sendGroupMessage();
    expect(ordinary.turns).toHaveLength(1);
    const ordinaryKey = ordinary.turns[0]?.sessionKey;
    expect(ordinaryKey).toBe(`agent:main:msteams:group:${chatId.toLowerCase()}`);

    // Documented `<channel>:<peerId>` key form with the bare Teams conversation id.
    const fanOut = await sendGroupMessage({ [`msteams:${chatId}`]: ["main", "helper"] });
    expect(
      fanOut.turns.map((turn) => turn.agentId ?? "").toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(["helper", "main"]);
    expect(fanOut.turns.find((turn) => turn.agentId === "main")?.sessionKey).toBe(ordinaryKey);
    expect(fanOut.turns.find((turn) => turn.agentId === "helper")?.sessionKey).toBe(
      `agent:helper:msteams:group:${chatId.toLowerCase()}`,
    );

    const removed = await sendGroupMessage();
    expect(removed.turns).toEqual(ordinary.turns);
    expect(ordinary.ctx?.ConversationRoutePeerId).toBe(chatId);
  });

  it("does not match the legacy conversation-prefixed broadcast key", async () => {
    const run = await sendGroupMessage({ [`msteams:conversation:${chatId}`]: ["main", "helper"] });
    expect(run.turns).toHaveLength(1);
    expect(run.turns[0]?.agentId).toBe("main");
  });
});
