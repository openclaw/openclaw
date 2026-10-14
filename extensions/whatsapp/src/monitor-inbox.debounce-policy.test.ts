import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import { createWhatsAppDurableInboundQueue } from "./inbound/durable-receive.js";
import { resolveWhatsAppIngressLifecycle } from "./inbound/ingress-lifecycle.js";
import {
  buildNotifyMessageUpsert,
  DEFAULT_ACCOUNT_ID,
  installWebMonitorInboxUnitTestHooks,
  settleInboundWork,
  startInboxMonitor,
  waitForMessageCalls,
  type InboxOnMessage,
} from "./monitor-inbox.test-harness.js";

installWebMonitorInboxUnitTestHooks();

it("updates WhatsApp timing and drains batches enabled after socket attachment", async () => {
  let cfg: OpenClawConfig = {
    channels: { whatsapp: { allowFrom: ["*"] } },
    messages: { inbound: { debounceMs: 0 } },
  };
  const onMessage = vi.fn<InboxOnMessage>(async () => {});
  const { listener, sock } = await startInboxMonitor(onMessage, { cfg, loadConfig: () => cfg });
  let sequence = 0;
  const enqueue = (text: string) => {
    sequence += 1;
    sock.ev.emit(
      "messages.upsert",
      buildNotifyMessageUpsert({
        id: `hot-debounce-${sequence}`,
        remoteJid: "999@s.whatsapp.net",
        text,
        timestamp: 1_700_000_000 + sequence,
      }),
    );
  };
  const publish = (debounceMs: number) => {
    cfg = { ...cfg, messages: { inbound: { byChannel: { whatsapp: debounceMs } } } };
  };
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  try {
    enqueue("immediate");
    await waitForMessageCalls(onMessage, 1);
    publish(60_000);
    enqueue("first");
    await settleInboundWork();
    expect(onMessage).toHaveBeenCalledTimes(1);
    publish(0);
    await vi.advanceTimersByTimeAsync(60_000);
    await waitForMessageCalls(onMessage, 2);
    enqueue("after disable");
    await waitForMessageCalls(onMessage, 3);
    expect(onMessage.mock.calls.map(([message]) => message.payload.body)).toEqual([
      "immediate",
      "first",
      "after disable",
    ]);
    publish(60_000);
    enqueue("pending at close");
    await settleInboundWork();
    expect(onMessage).toHaveBeenCalledTimes(3);
  } finally {
    await listener.close();
    vi.useRealTimers();
  }
  expect(onMessage).toHaveBeenCalledTimes(4);
  expect(onMessage.mock.calls.at(-1)?.[0].payload.body).toBe("pending at close");
  expect(sock.end).toHaveBeenCalledTimes(1);
});

it.each(["quoted reply", "buffered text"] as const)(
  "keeps group sender batches ordered before another sender's %s",
  async (followUp) => {
    const onMessage = vi.fn<InboxOnMessage>(async () => {});
    const queue = createWhatsAppDurableInboundQueue(DEFAULT_ACCOUNT_ID);
    const finalMessagePrepared = createDeferred<void>();
    const { listener, sock } = await startInboxMonitor(onMessage, {
      debounceMs: 60_000,
      durableInboundQueue: queue,
      shouldDebounce: (message) => {
        if (message.event.id === "group-a-fourth") {
          finalMessagePrepared.resolve();
        }
        return !message.quote?.id;
      },
    });
    const first = buildNotifyMessageUpsert({
      id: "group-a-first",
      remoteJid: "123@g.us",
      participant: "111@s.whatsapp.net",
      text: "first",
      timestamp: 1_700_000_000,
    });
    const second = buildNotifyMessageUpsert({
      id: "group-a-second",
      remoteJid: "123@g.us",
      participant: "111@s.whatsapp.net",
      text: "second",
      timestamp: 1_700_000_001,
    });
    const third = {
      key: {
        id: "group-b-third",
        remoteJid: "123@g.us",
        participant: "222@s.whatsapp.net",
        fromMe: false,
      },
      message:
        followUp === "quoted reply"
          ? {
              extendedTextMessage: {
                text: "third",
                contextInfo: {
                  stanzaId: "earlier",
                  participant: "111@s.whatsapp.net",
                  quotedMessage: { conversation: "original" },
                },
              },
            }
          : { conversation: "third" },
      messageTimestamp: 1_700_000_002,
    };
    const fourth = buildNotifyMessageUpsert({
      id: "group-a-fourth",
      remoteJid: "123@g.us",
      participant: "111@s.whatsapp.net",
      text: "fourth",
      timestamp: 1_700_000_003,
    });
    try {
      sock.ev.emit("messages.upsert", {
        type: "notify",
        messages: [...first.messages, ...second.messages, third, ...fourth.messages],
      });
      await finalMessagePrepared.promise;
    } finally {
      await listener.close();
    }
    expect(
      onMessage.mock.calls.map(([message]) => ({
        body: message.payload.body,
        sender: message.platform.senderJid,
      })),
    ).toEqual([
      { body: "first\nsecond", sender: "111@s.whatsapp.net" },
      { body: "third", sender: "222@s.whatsapp.net" },
      { body: "fourth", sender: "111@s.whatsapp.net" },
    ]);
    expect(await queue.listClaims()).toEqual([]);
    expect(await queue.listPending({ limit: "all" })).toEqual([]);
    expect(sock.readMessages).toHaveBeenCalledTimes(4);
    for (const id of ["group-a-first", "group-a-second", "group-b-third", "group-a-fourth"]) {
      expect(sock.readMessages).toHaveBeenCalledWith([expect.objectContaining({ id })]);
    }
  },
);

it("keeps a sender switch behind an active admission without blocking another conversation", async () => {
  const releaseFirst = createDeferred<void>();
  const firstStarted = createDeferred<void>();
  const otherStarted = createDeferred<void>();
  const onMessage = vi.fn<InboxOnMessage>(async (message) => {
    if (message.payload.body === "first") {
      firstStarted.resolve();
      await releaseFirst.promise;
    }
    if (message.payload.body === "other conversation") {
      otherStarted.resolve();
    }
    await resolveWhatsAppIngressLifecycle(message)?.onAdopted();
  });
  const { listener, sock } = await startInboxMonitor(onMessage, {
    debounceMs: 20,
    shouldDebounce: (message) => message.payload.body === "first",
  });
  try {
    sock.ev.emit(
      "messages.upsert",
      buildNotifyMessageUpsert({
        id: "group-held-first",
        remoteJid: "123@g.us",
        participant: "111@s.whatsapp.net",
        text: "first",
        timestamp: 1_700_000_000,
      }),
    );
    await firstStarted.promise;
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        ...buildNotifyMessageUpsert({
          id: "group-held-second",
          remoteJid: "123@g.us",
          participant: "222@s.whatsapp.net",
          text: "second",
          timestamp: 1_700_000_001,
        }).messages,
        ...buildNotifyMessageUpsert({
          id: "group-independent",
          remoteJid: "456@g.us",
          participant: "222@s.whatsapp.net",
          text: "other conversation",
          timestamp: 1_700_000_002,
        }).messages,
      ],
    });
    await otherStarted.promise;
    await settleInboundWork();
    expect(onMessage.mock.calls.map(([message]) => message.payload.body)).toEqual([
      "first",
      "other conversation",
    ]);
    releaseFirst.resolve();
    await waitForMessageCalls(onMessage, 3);
    expect(onMessage.mock.calls.at(-1)?.[0].payload.body).toBe("second");
  } finally {
    releaseFirst.resolve();
    await listener.close();
  }
});
