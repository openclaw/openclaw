import type { PreparedInboundReply } from "openclaw/plugin-sdk/channel-inbound";
import { createReplyDispatcher, dispatchInboundMessage } from "openclaw/plugin-sdk/reply-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "../../config-doctor-api.js";
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
  return sendMessage(broadcast, { id: chatId, conversationType: "groupChat" });
}

async function sendMessage(
  broadcast: OpenClawConfig["broadcast"] | undefined,
  conversation: { id: string; conversationType: string },
) {
  const cfg: OpenClawConfig = {
    agents: { entries: { main: {}, helper: {} } },
    bindings: [{ agentId: "main", match: { channel: "msteams" } }],
    channels: {
      msteams: { groupPolicy: "open", dmPolicy: "open", allowFrom: ["*"], requireMention: false },
    },
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
      conversation,
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

  it("keeps fanning out after Doctor migrates a legacy conversation-prefixed key", async () => {
    const legacy = { [`msteams:conversation:${chatId}`]: ["main", "helper"] };
    const canonical = ["main"];
    const migrated = normalizeCompatibilityConfig({
      cfg: { broadcast: { ...legacy, "msteams:19:other@thread.v2": canonical } },
    });
    expect(migrated.changes).toEqual([
      `Moved broadcast."msteams:conversation:${chatId}" → broadcast."msteams:${chatId}".`,
    ]);
    expect(migrated.config.broadcast).toEqual({
      [`msteams:${chatId}`]: ["main", "helper"],
      "msteams:19:other@thread.v2": canonical,
    });
    expect(legacyConfigRules.some((rule) => rule.match?.(migrated.config.broadcast, {}))).toBe(
      false,
    );

    const run = await sendGroupMessage(migrated.config.broadcast);
    expect(
      run.turns.map((turn) => turn.sessionKey).toSorted((a, b) => (a ?? "").localeCompare(b ?? "")),
    ).toEqual([
      `agent:helper:msteams:group:${chatId.toLowerCase()}`,
      `agent:main:msteams:group:${chatId.toLowerCase()}`,
    ]);
  });

  it.each([
    ["identical", ["main"], []],
    ["differing", ["helper"], ["canonical participants were kept"]],
  ] as const)(
    "resolves a %s legacy/canonical collision to the canonical entry",
    (_, legacy, warn) => {
      const broadcast = {
        [`msteams:conversation:${chatId}`]: [...legacy],
        [`msteams:${chatId}`]: ["main"],
      };
      expect(legacyConfigRules.some((rule) => rule.match?.(broadcast, {}))).toBe(true);
      const migrated = normalizeCompatibilityConfig({ cfg: { broadcast } });
      expect(migrated.changes).toEqual([
        `Removed broadcast."msteams:conversation:${chatId}"; kept existing broadcast."msteams:${chatId}".`,
      ]);
      expect(migrated.config.broadcast).toEqual({ [`msteams:${chatId}`]: ["main"] });
      expect(legacyConfigRules.some((rule) => rule.match?.(migrated.config.broadcast, {}))).toBe(
        false,
      );
      const warnings = migrated.warnings ?? [];
      expect(warnings).toHaveLength(warn.length);
      for (const text of warn) {
        expect(warnings.join(" ")).toContain(text);
      }
      expect(normalizeCompatibilityConfig({ cfg: migrated.config }).changes).toEqual([]);
    },
  );

  it("leaves DM and channel broadcast keys for their existing runtime lookup", async () => {
    const broadcast = {
      "msteams:conversation:a:bot-framework-dm": ["main", "helper"],
      "msteams:conversation:19:channel@thread.tacv2": ["main"],
    };
    expect(legacyConfigRules.some((rule) => rule.match?.(broadcast, {}))).toBe(false);
    const migrated = normalizeCompatibilityConfig({ cfg: { broadcast } });
    expect(migrated.changes).toEqual([]);
    expect(migrated.config.broadcast).toEqual(broadcast);

    const dm = await sendMessage(broadcast, {
      id: "a:bot-framework-dm",
      conversationType: "personal",
    });
    expect(
      dm.turns.map((turn) => turn.agentId ?? "").toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(["helper", "main"]);
  });
});
