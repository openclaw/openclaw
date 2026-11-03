import { describe, expect, it, vi } from "vitest";
import {
  getSock,
  installWebMonitorInboxUnitTestHooks,
  startInboxMonitor,
  waitForInboundWorkDrained,
} from "./monitor-inbox.test-harness.js";
describe("web monitor inbox", () => {
  installWebMonitorInboxUnitTestHooks();

  function groupUpsert(id: string, remoteJid: string, participant: string, message: unknown) {
    const key = { id, fromMe: false, remoteJid, participant };
    return { type: "notify", messages: [{ key, message }] };
  }

  async function runSingleUpsertAndCapture(upsert: unknown) {
    const onMessage = vi.fn();
    const { listener, sock } = await startInboxMonitor(onMessage);
    sock.ev.emit("messages.upsert", upsert);
    // The monitor owns async media and delivery work; wait for its drain instead of polling.
    await waitForInboundWorkDrained();
    return { onMessage, listener, sock };
  }

  it("socket session resolves onClose when the socket closes", async () => {
    const { listener } = await startInboxMonitor(vi.fn());
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
    const { listener } = await startInboxMonitor(vi.fn());
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
    const { listener, sock } = await runSingleUpsertAndCapture(
      groupUpsert("grp1", "12345-67890@g.us", "111@s.whatsapp.net", { conversation: "group ping" }),
    );

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
    const { onMessage, listener } = await runSingleUpsertAndCapture(
      groupUpsert("grp-ephem", "424242@g.us", "888@s.whatsapp.net", {
        ephemeralMessage: {
          message: {
            extendedTextMessage: {
              text: "oh hey @Clawd UK !",
              contextInfo: { mentionedJid: ["123@s.whatsapp.net"] },
            },
          },
        },
      }),
    );
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        admission: expect.objectContaining({
          conversation: expect.objectContaining({ kind: "group", id: "424242@g.us" }),
        }),
        group: expect.objectContaining({
          mentions: expect.objectContaining({
            jids: ["123@s.whatsapp.net"],
          }),
        }),
        payload: expect.objectContaining({ body: "oh hey @Clawd UK !" }),
        platform: expect.objectContaining({ senderE164: "+888" }),
      }),
    );
    await listener.close();
  });
});
