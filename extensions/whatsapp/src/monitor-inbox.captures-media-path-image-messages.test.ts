import "./monitor-inbox.test-harness.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ACCOUNT_ID,
  getAuthDir,
  getMonitorWebInbox,
  getSock,
  installWebMonitorInboxUnitTestHooks,
} from "./monitor-inbox.test-harness.js";
let monitorWebInbox: typeof import("./inbound.js").monitorWebInbox;

describe("web monitor inbox", () => {
  installWebMonitorInboxUnitTestHooks();

  beforeEach(() => {
    monitorWebInbox = getMonitorWebInbox();
  });

  async function openMonitor(onMessage = vi.fn()) {
    return await monitorWebInbox({
      verbose: false,
      accountId: DEFAULT_ACCOUNT_ID,
      authDir: getAuthDir(),
      onMessage,
    });
  }

  async function runSingleUpsertAndCapture(upsert: unknown) {
    const onMessage = vi.fn();
    const listener = await openMonitor(onMessage);
    const sock = getSock();
    sock.ev.emit("messages.upsert", upsert);
    await new Promise((resolve) => setTimeout(resolve, 25));
    return { onMessage, listener, sock };
  }

  it("captures media path for image messages", async () => {
    const { onMessage, listener, sock } = await runSingleUpsertAndCapture({
      type: "notify",
      messages: [
        {
          key: { id: "med1", fromMe: false, remoteJid: "888@s.whatsapp.net" },
          message: { imageMessage: { mimetype: "image/jpeg" } },
          messageTimestamp: 1_700_000_100,
        },
      ],
    });

    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "<media:image>",
      }),
    );
    expect(sock.readMessages).toHaveBeenCalledWith([
      {
        remoteJid: "888@s.whatsapp.net",
        id: "med1",
        participant: undefined,
        fromMe: false,
      },
    ]);
    expect(sock.sendPresenceUpdate).toHaveBeenNthCalledWith(1, "available");
    await listener.close();
  });
});
