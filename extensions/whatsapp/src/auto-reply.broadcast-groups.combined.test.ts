// Whatsapp tests cover auto reply.broadcast groups.combined plugin behavior.
import "./test-helpers.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import {
  monitorWebChannelWithCapture,
  sendWebDirectInboundAndCollectSessionKeys,
} from "./auto-reply.broadcast-groups.test-harness.js";
import {
  createWebInboundDeliverySpies,
  installWebAutoReplyTestHomeHooks,
  installWebAutoReplyUnitTestHooks,
  resetLoadConfigMock,
  sendWebGroupInboundMessage,
  setLoadConfigMock,
} from "./auto-reply.test-harness.js";
import { maybeBroadcastMessage } from "./auto-reply/monitor/broadcast.js";
import { createTestWebInboundMessage } from "./inbound/test-message.test-helper.js";

installWebAutoReplyTestHomeHooks();

describe("broadcast groups", () => {
  installWebAutoReplyUnitTestHooks();

  it("skips unknown broadcast agent ids when agents.list is present", async () => {
    setLoadConfigMock({
      channels: { whatsapp: { allowFrom: ["*"] } },
      agents: {
        defaults: { maxConcurrent: 10 },
        list: [{ id: "alfred" }],
      },
      broadcast: {
        "+1000": ["alfred", "missing"],
      },
    } satisfies OpenClawConfig);

    const { seen, resolver } = await sendWebDirectInboundAndCollectSessionKeys();

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(seen[0]).toContain("agent:alfred:");
    resetLoadConfigMock();
  });

  it("broadcasts sequentially in configured order", async () => {
    setLoadConfigMock({
      channels: { whatsapp: { allowFrom: ["*"] } },
      agents: {
        defaults: { maxConcurrent: 10 },
        list: [{ id: "alfred" }, { id: "baerbel" }],
      },
      broadcast: {
        strategy: "sequential",
        "+1000": ["alfred", "baerbel"],
      },
    } satisfies OpenClawConfig);

    const { seen, resolver } = await sendWebDirectInboundAndCollectSessionKeys();

    expect(resolver).toHaveBeenCalledTimes(2);
    expect(seen[0]).toContain("agent:alfred:");
    expect(seen[1]).toContain("agent:baerbel:");
    resetLoadConfigMock();
  });

  it("shares group history across broadcast agents and clears after replying", async () => {
    setLoadConfigMock({
      channels: { whatsapp: { allowFrom: ["*"] } },
      agents: {
        defaults: { maxConcurrent: 10 },
        list: [{ id: "alfred" }, { id: "baerbel" }],
      },
      broadcast: {
        strategy: "sequential",
        "123@g.us": ["alfred", "baerbel"],
      },
    } satisfies OpenClawConfig);

    const resolver = vi.fn().mockResolvedValue({ text: "ok" });

    const { spies, onMessage } = await monitorWebChannelWithCapture(resolver);

    await sendWebGroupInboundMessage({
      onMessage,
      spies,
      body: "hello group",
      id: "g1",
      senderE164: "+111",
      senderName: "Alice",
      selfE164: "+999",
    });

    expect(resolver).not.toHaveBeenCalled();

    await sendWebGroupInboundMessage({
      onMessage,
      spies,
      body: "@bot ping",
      id: "g2",
      senderE164: "+222",
      senderName: "Bob",
      mentionedJids: ["999@s.whatsapp.net"],
      selfE164: "+999",
      selfJid: "999@s.whatsapp.net",
    });

    expect(resolver).toHaveBeenCalledTimes(2);
    for (const call of resolver.mock.calls.slice(0, 2)) {
      const payload = call[0] as {
        Body: string;
        SenderName?: string;
        SenderE164?: string;
        SenderId?: string;
      };
      expect(payload.Body).toContain("Chat messages since your last reply");
      expect(payload.Body).toContain("Alice (+111): hello group");
      expect(payload.Body).not.toContain("[message_id:");
      expect(payload.Body).toContain("@bot ping");
      expect(payload.SenderName).toBe("Bob");
      expect(payload.SenderE164).toBe("+222");
      expect(payload.SenderId).toBe("+222");
    }

    await sendWebGroupInboundMessage({
      onMessage,
      spies,
      body: "@bot ping 2",
      id: "g3",
      senderE164: "+333",
      senderName: "Clara",
      mentionedJids: ["999@s.whatsapp.net"],
      selfE164: "+999",
      selfJid: "999@s.whatsapp.net",
    });

    expect(resolver).toHaveBeenCalledTimes(4);
    for (const call of resolver.mock.calls.slice(2, 4)) {
      const payload = call[0] as { Body: string };
      expect(payload.Body).not.toContain("Alice (+111): hello group");
      expect(payload.Body).not.toContain("Chat messages since your last reply");
    }

    resetLoadConfigMock();
  });

  it("clears broadcast group history once after every agent finishes", async () => {
    const historyKey = "whatsapp:default:group:123@g.us";
    const groupHistories = new Map([[historyKey, [{ sender: "Alice", body: "pending" }]]]);
    const setSpy = vi.spyOn(groupHistories, "set");
    const processMessage = vi.fn(async () => true);
    const msg = createTestWebInboundMessage({
      admission: {
        conversation: { kind: "group", id: "123@g.us" },
      },
    });

    const result = await maybeBroadcastMessage({
      cfg: {
        agents: { list: [{ id: "alfred" }, { id: "baerbel" }] },
        broadcast: { strategy: "parallel", "123@g.us": ["alfred", "baerbel"] },
      },
      msg,
      peerId: "123@g.us",
      route: {
        agentId: "main",
        channel: "whatsapp",
        accountId: "default",
        sessionKey: "agent:main:whatsapp:group:123@g.us",
        mainSessionKey: "agent:main:main",
        lastRoutePolicy: "main",
        matchedBy: "default",
      },
      groupHistoryKey: historyKey,
      groupHistories,
      processMessage,
    });

    expect(result).toBe(true);
    expect(processMessage).toHaveBeenCalledTimes(2);
    for (const call of processMessage.mock.calls as unknown[][]) {
      expect(call[3]).toMatchObject({
        groupHistory: [{ sender: "Alice", body: "pending" }],
        suppressGroupHistoryClear: true,
      });
    }
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledWith(historyKey, []);
  });

  it("keeps named-account group broadcast routes on the scoped session key", async () => {
    setLoadConfigMock({
      channels: {
        whatsapp: {
          allowFrom: ["*"],
          accounts: {
            work: {
              allowFrom: ["*"],
            },
          },
        },
      },
      agents: {
        defaults: { maxConcurrent: 10 },
        list: [{ id: "alfred" }, { id: "baerbel" }],
      },
      broadcast: {
        strategy: "sequential",
        "123@g.us": ["alfred", "baerbel"],
      },
    } satisfies OpenClawConfig);

    const seen: string[] = [];
    const resolver = vi.fn(async (ctx: { SessionKey?: unknown }) => {
      seen.push(String(ctx.SessionKey));
      return { text: "ok" };
    });

    const { spies, onMessage } = await monitorWebChannelWithCapture(resolver);

    await sendWebGroupInboundMessage({
      onMessage,
      spies,
      body: "@bot ping",
      id: "g-work-1",
      senderE164: "+111",
      senderName: "Alice",
      mentionedJids: ["999@s.whatsapp.net"],
      selfE164: "+999",
      selfJid: "999@s.whatsapp.net",
      accountId: "work",
    });

    expect(resolver).toHaveBeenCalledTimes(2);
    expect(seen).toEqual([
      "agent:alfred:whatsapp:group:123@g.us:thread:whatsapp-account-work",
      "agent:baerbel:whatsapp:group:123@g.us:thread:whatsapp-account-work",
    ]);
    resetLoadConfigMock();
  });

  it("broadcasts in parallel by default", async () => {
    setLoadConfigMock({
      channels: { whatsapp: { allowFrom: ["*"] } },
      agents: {
        defaults: { maxConcurrent: 10 },
        list: [{ id: "alfred" }, { id: "baerbel" }],
      },
      broadcast: {
        strategy: "parallel",
        "+1000": ["alfred", "baerbel"],
      },
    } satisfies OpenClawConfig);

    const { sendMedia, reply, sendComposing } = createWebInboundDeliverySpies();

    let started = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const resolver = vi.fn(async () => {
      started += 1;
      if (started < 2) {
        await gate;
      } else {
        release?.();
      }
      return { text: "ok" };
    });

    const { onMessage: capturedOnMessage } = await monitorWebChannelWithCapture(resolver);

    await capturedOnMessage(
      createTestWebInboundMessage({
        event: {
          id: "m1",
          timestamp: Date.now(),
        },
        payload: {
          body: "hello",
        },
        platform: {
          chatJid: "direct:+1000",
          recipientJid: "+2000",
          sendComposing,
          reply,
          sendMedia,
        },
        admission: {
          accountId: "default",
          conversation: {
            kind: "direct",
            id: "+1000",
          },
        },
      }),
    );

    expect(resolver).toHaveBeenCalledTimes(2);
    resetLoadConfigMock();
  });
});
