import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import {
  type InboxOnMessage,
  installWebMonitorInboxUnitTestHooks,
  startInboxMonitor,
} from "../monitor-inbox.test-harness.js";

installWebMonitorInboxUnitTestHooks();

it("delivers both shared contacts with the follow-up text in the same batch", async () => {
  const onMessage = vi.fn<InboxOnMessage>(async () => {});
  const followUpPrepared = createDeferred<void>();
  const { listener, sock } = await startInboxMonitor(onMessage, {
    debounceMs: 60_000,
    shouldDebounce: (message) => {
      if (message.event.id === "follow-up") {
        followUpPrepared.resolve();
      }
      return true;
    },
  });
  const chat = { remoteJid: "999@s.whatsapp.net", fromMe: false };
  try {
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { ...chat, id: "first-card" },
          message: { contactMessage: { displayName: "Ada Example" } },
          messageTimestamp: 1_700_000_000,
        },
        {
          key: { ...chat, id: "contact-list" },
          message: { contactsArrayMessage: { contacts: [{ displayName: "Bo Example" }] } },
          messageTimestamp: 1_700_000_001,
        },
        {
          key: { ...chat, id: "follow-up" },
          message: { conversation: "please introduce them" },
          messageTimestamp: 1_700_000_002,
        },
      ],
    });
    await followUpPrepared.promise;
  } finally {
    await listener.close();
  }
  expect(onMessage).toHaveBeenCalledTimes(1);
  const [message] = onMessage.mock.calls[0]!;
  expect(message.event).toMatchObject({ id: "follow-up", isBatched: true });
  expect(message.payload.body).toBe("<contact>\n<contacts: 1 contact>\nplease introduce them");
  expect(message.payload.channelStructuredContext).toMatchObject([
    { type: "contact", payload: { contacts: [{ name: "Ada Example" }] } },
    { type: "contacts", payload: { contacts: [{ name: "Bo Example" }] } },
  ]);
});
