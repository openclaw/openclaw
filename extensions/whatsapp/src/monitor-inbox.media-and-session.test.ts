// WhatsApp monitor inbox media and session behavior.
import { describe, expect, it, vi } from "vitest";
import {
  getSock,
  installWebMonitorInboxUnitTestHooks,
  startInboxMonitor,
  waitForInboundWorkDrained,
} from "./monitor-inbox.test-harness.js";
describe("web monitor inbox", () => {
  installWebMonitorInboxUnitTestHooks();

  async function openMonitor(onMessage = vi.fn()) {
    const { listener } = await startInboxMonitor(onMessage);
    return listener;
  }

  async function runSingleUpsertAndCapture(upsert: unknown) {
    const onMessage = vi.fn();
    const { listener, sock } = await startInboxMonitor(onMessage);
    sock.ev.emit("messages.upsert", upsert);
    // The monitor owns async media and delivery work; wait for its drain instead of polling.
    await waitForInboundWorkDrained();
    return { onMessage, listener, sock };
  }

  function expectSingleGroupMessage(
    onMessage: ReturnType<typeof vi.fn>,
    expected: Record<string, unknown>,
  ) {
    expect(onMessage).toHaveBeenCalledTimes(1);
    const message = onMessage.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    if (!message) {
      throw new Error("expected inbound group message");
    }
    for (const [key, value] of Object.entries(expected)) {
      expect(message[key]).toEqual(value);
    }
  }

  it("socket session resolves onClose when the socket closes", async () => {
    const listener = await openMonitor(vi.fn());
    const sock = getSock();
    const reasonPromise = listener.onClose;
    sock.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 500 } } },
    });
    await expect(reasonPromise).resolves.toEqual({
      status: 500,
      isLoggedOut: false,
      error: { output: { statusCode: 500 } },
    });
    await listener.close();
  });

  it("socket session detaches inbound listeners and ends the socket on close()", async () => {
    const listener = await openMonitor(vi.fn());
    const sock = getSock();

    expect(sock.ev.listenerCount("messages.upsert")).toBeGreaterThan(0);
    expect(sock.ev.listenerCount("connection.update")).toBeGreaterThan(0);

    await listener.close();

    expect(sock.ev.listenerCount("messages.upsert")).toBe(0);
    expect(sock.ev.listenerCount("connection.update")).toBe(0);
    expect(sock.end).toHaveBeenCalledTimes(1);
    const closeError = sock.end.mock.calls[0]?.[0];
    expect(closeError).toBeInstanceOf(Error);
    expect(closeError?.message).toBe("OpenClaw WhatsApp listener close");
    expect(sock.ws.close).not.toHaveBeenCalled();
  });

  it("includes participant when marking group messages read", async () => {
    const { listener, sock } = await runSingleUpsertAndCapture({
      type: "notify",
      messages: [
        {
          key: {
            id: "grp1",
            fromMe: false,
            remoteJid: "12345-67890@g.us",
            participant: "111@s.whatsapp.net",
          },
          message: { conversation: "group ping" },
        },
      ],
    });

    expect(sock.readMessages).toHaveBeenCalledWith([
      {
        remoteJid: "12345-67890@g.us",
        id: "grp1",
        participant: "111@s.whatsapp.net",
        fromMe: false,
      },
    ]);
    await listener.close();
  });

  it("unwraps ephemeral messages, preserves mentions, and still delivers group pings", async () => {
    const { onMessage, listener } = await runSingleUpsertAndCapture({
      type: "notify",
      messages: [
        {
          key: {
            id: "grp-ephem",
            fromMe: false,
            remoteJid: "424242@g.us",
            participant: "888@s.whatsapp.net",
          },
          message: {
            ephemeralMessage: {
              message: {
                extendedTextMessage: {
                  text: "oh hey @Clawd UK !",
                  contextInfo: { mentionedJid: ["123@s.whatsapp.net"] },
                },
              },
            },
          },
        },
      ],
    });
    expectSingleGroupMessage(onMessage, {
      admission: expect.objectContaining({
        conversation: expect.objectContaining({
          kind: "group",
          id: "424242@g.us",
        }),
      }),
      group: expect.objectContaining({
        mentions: expect.objectContaining({
          jids: ["123@s.whatsapp.net"],
        }),
      }),
      payload: expect.objectContaining({
        body: "oh hey @Clawd UK !",
      }),
      platform: expect.objectContaining({
        senderE164: "+888",
      }),
    });
    await listener.close();
  });
});
