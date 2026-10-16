import "./test-helpers.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  monitorWebChannelWithCapture,
  sendWebDirectInboundAndCollectSessionKeys,
} from "./auto-reply.broadcast-groups.test-harness.js";
import {
  installWebAutoReplyTestHomeHooks,
  installWebAutoReplyUnitTestHooks,
  resetLoadConfigMock,
  sendWebDirectInboundMessage,
  sendWebGroupInboundMessage,
  setLoadConfigMock,
} from "./auto-reply.test-harness.js";
import { maybeBroadcastMessage } from "./auto-reply/monitor/broadcast.js";
import { createTestWebAudioInboundMessage } from "./inbound/test-message.test-helper.js";

installWebAutoReplyTestHomeHooks();

function broadcastConfig(
  broadcast?: OpenClawConfig["broadcast"],
  accountId?: string,
): OpenClawConfig {
  const entries: NonNullable<OpenClawConfig["agents"]>["entries"] = accountId
    ? { alfred: {}, baerbel: {} }
    : { alfred: {} };
  return {
    channels: {
      whatsapp: {
        allowFrom: ["*"],
        ...(accountId && accountId !== "default"
          ? { accounts: { [accountId]: { allowFrom: ["*"] } } }
          : {}),
      },
    },
    agents: { defaults: { maxConcurrent: 10 }, entries },
    bindings: accountId
      ? [{ agentId: "alfred", match: { channel: "whatsapp", accountId } }]
      : undefined,
    broadcast,
  };
}

describe("broadcast groups", () => {
  installWebAutoReplyUnitTestHooks();
  afterEach(resetLoadConfigMock);

  it("skips unknown broadcast agent ids", async () => {
    setLoadConfigMock(broadcastConfig({ "+1000": ["alfred", "missing"] }));

    const { seen, resolver } = await sendWebDirectInboundAndCollectSessionKeys();

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(seen[0]).toContain("agent:alfred:");
  });

  it("keeps caption mentions when selecting participants for transcribed audio", async () => {
    const mentioned = (id: string) => ({ groupChat: { mentionPatterns: [`@${id}\\b`] } });
    const peer = { kind: "direct", id: "+15550000002" } as const;
    const cfg: OpenClawConfig = {
      agents: { entries: { alfred: mentioned("alfred"), carla: mentioned("carla") } },
      bindings: [{ agentId: "alfred", match: { channel: "whatsapp", accountId: "default" } }],
      broadcast: { "whatsapp:+15550000002": { agents: ["alfred", "carla"] } },
    };
    const participants: string[] = [];
    const transcript = "Please review the attached voice note.";
    await maybeBroadcastMessage({
      cfg,
      msg: createTestWebAudioInboundMessage({ payload: { body: "@carla please review" } }),
      peerId: peer.id,
      route: resolveAgentRoute({ cfg, channel: "whatsapp", accountId: "default", peer }),
      groupHistoryKey: "caption-history",
      groupHistories: new Map(),
      preflightAudioTranscript: transcript,
      processMessage: async (_msg, route, _historyKey, opts) => {
        participants.push(route.agentId);
        expect(opts?.preflightAudioTranscript).toBe(transcript);
        return true;
      },
    });
    expect(participants).toEqual(["carla"]);
  });

  it("applies recipient and strategy changes on the same active listener", async () => {
    const base = broadcastConfig(undefined, "default");
    const phases = [
      { strategy: "sequential", recipients: ["alfred"] },
      { strategy: "parallel", recipients: ["alfred", "baerbel"] },
      { strategy: "sequential", recipients: ["baerbel", "alfred"] },
      { strategy: "sequential", recipients: ["baerbel"] },
    ] as const;
    let phase: (typeof phases)[number] = phases[0];
    const configure = () =>
      setLoadConfigMock({
        ...base,
        broadcast: { strategy: phase.strategy, "+1000": [...phase.recipients] },
      } satisfies OpenClawConfig);
    let active = 0;
    let peak = 0;
    let gate = createDeferred<void>();
    const seen: Array<{ agent: string; strategy?: string }> = [];
    const resolver = vi.fn(
      async (ctx: { SessionKey?: unknown }, _opts: unknown, cfg: OpenClawConfig) => {
        seen.push({
          agent: String(ctx.SessionKey).split(":")[1] ?? "",
          strategy: cfg.broadcast?.strategy,
        });
        active += 1;
        peak = Math.max(peak, active);
        if (phase.strategy === "parallel" && active === 1) {
          await gate.promise;
        }
        await Promise.resolve();
        active -= 1;
        return { text: "ok" };
      },
    );
    configure();
    const { spies, onMessage } = await monitorWebChannelWithCapture(resolver);
    for (const [index, next] of phases.entries()) {
      phase = next;
      configure();
      seen.length = 0;
      peak = 0;
      gate = createDeferred<void>();
      const delivery = sendWebDirectInboundMessage({
        onMessage,
        spies,
        id: `reload-${index}`,
        from: "+1000",
        to: "+2000",
        body: "hello",
      });
      try {
        if (phase.strategy === "parallel") {
          await vi.waitFor(() => expect(peak).toBe(2));
        }
      } finally {
        // A failed concurrency assertion must release the first recipient before teardown.
        gate.resolve();
        await delivery;
      }
      const expected = phase.recipients.map((agent) => ({ agent, strategy: phase.strategy }));
      expect(seen).toHaveLength(expected.length);
      expect(seen).toEqual(
        phase.strategy === "parallel" ? expect.arrayContaining(expected) : expected,
      );
      expect(peak).toBe(phase.strategy === "parallel" ? 2 : 1);
      expect(active).toBe(0);
    }
  });

  it.each(["default", "work"])(
    "shares and clears group history on the %s account route",
    async (accountId) => {
      setLoadConfigMock(
        broadcastConfig({ strategy: "sequential", "123@g.us": ["alfred", "baerbel"] }, accountId),
      );

      const resolver = vi.fn(async (_ctx: { Body: string; SessionKey?: string }) => ({
        text: "ok",
      }));

      const { spies, onMessage } = await monitorWebChannelWithCapture(resolver);
      const sendGroup = (
        id: string,
        body: string,
        senderName: "Alice" | "Bob" | "Clara",
        mention = false,
      ) =>
        sendWebGroupInboundMessage({
          spies,
          onMessage,
          id,
          body,
          senderName,
          senderE164: { Alice: "+111", Bob: "+222", Clara: "+333" }[senderName],
          selfE164: "+999",
          accountId: accountId === "work" ? accountId : undefined,
          ...(mention
            ? { mentionedJids: ["999@s.whatsapp.net"], selfJid: "999@s.whatsapp.net" }
            : {}),
        });

      await sendGroup("g1", "hello group", "Alice");

      expect(resolver).not.toHaveBeenCalled();

      await sendGroup("g2", "@bot ping", "Bob", true);

      expect(resolver).toHaveBeenCalledTimes(2);
      if (accountId === "work") {
        expect(resolver.mock.calls.slice(0, 2).map(([ctx]) => ctx.SessionKey)).toEqual([
          "agent:alfred:whatsapp:group:123@g.us:thread:whatsapp-account-work",
          "agent:baerbel:whatsapp:group:123@g.us:thread:whatsapp-account-work",
        ]);
      }
      for (const [payload] of resolver.mock.calls.slice(0, 2)) {
        expect(payload.Body).toContain("Chat messages since your last reply");
        expect(payload.Body).toContain("Alice (+111): hello group");
        expect(payload.Body).not.toContain("[message_id:");
        expect(payload.Body).toContain("@bot ping");
        expect(payload).toMatchObject({ SenderName: "Bob", SenderE164: "+222", SenderId: "+222" });
      }

      await sendGroup("g3", "@bot ping 2", "Clara", true);

      expect(resolver).toHaveBeenCalledTimes(4);
      for (const [payload] of resolver.mock.calls.slice(2, 4)) {
        expect(payload.Body).not.toContain("Alice (+111): hello group");
        expect(payload.Body).not.toContain("Chat messages since your last reply");
      }
    },
  );
});
