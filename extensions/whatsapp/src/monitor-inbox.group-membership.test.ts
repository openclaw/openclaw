import {
  addTestHook,
  createEmptyPluginRegistry,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  groupMetadata,
  installStreamsInboundMessageHooks,
} from "./monitor-inbox.streams-inbound-messages.test-support.js";
import {
  getSock,
  settleInboundWork,
  startInboxMonitor,
  type InboxMonitorOptions,
} from "./monitor-inbox.test-harness.js";

function observeMembership() {
  const observed = vi.fn();
  const registry = createEmptyPluginRegistry();
  addTestHook({
    registry,
    pluginId: "membership-observer",
    hookName: "channel_group_membership_changed",
    conversationAccessAllowed: true,
    handler: observed,
  });
  setActivePluginRegistry(registry);
  initializeGlobalHookRunner(registry);
  onTestFinished(() => {
    resetGlobalHookRunner();
    resetPluginRuntimeStateForTest();
  });
  return observed;
}

describe("WhatsApp group membership observations", () => {
  installStreamsInboundMessageHooks();

  it("exposes live membership actors before message admission and detaches on close", async () => {
    const observed = observeMembership();
    const sock = getSock();
    const currentRoster = groupMetadata({ subject: "Existing group", participants: [] });
    sock.groupFetchAllParticipating.mockResolvedValueOnce({ "123@g.us": currentRoster });
    const cache: NonNullable<InboxMonitorOptions["groupMetadataCache"]> = new Map();
    const onMessage = vi.fn();
    const { listener } = await startInboxMonitor(onMessage, {
      cfg: { channels: { whatsapp: { groupPolicy: "disabled" } } },
      groupMetadataCache: cache,
    });
    onTestFinished(() => listener.close());
    await vi.waitFor(() => expect(cache.get("123@g.us")?.subject).toBe("Existing group"));
    expect(observed).not.toHaveBeenCalled();

    sock.ev.emit("groups.upsert", [
      { ...currentRoster, author: "456@lid", authorPn: "15551234567@s.whatsapp.net" },
    ]);
    await vi.waitFor(() => expect(observed).toHaveBeenCalledTimes(1));
    expect(observed).toHaveBeenNthCalledWith(
      1,
      {
        kind: "group_observed",
        actorId: "456@lid",
        actorPhoneNumberId: "15551234567@s.whatsapp.net",
        participants: [],
        selfIds: expect.arrayContaining(["123@s.whatsapp.net"]),
      },
      expect.objectContaining({
        channelId: "whatsapp",
        accountId: "default",
        conversationId: "123@g.us",
        signal: expect.any(AbortSignal),
      }),
    );

    sock.ev.emit("group-participants.update", {
      id: "123@g.us",
      action: "add",
      author: "456@lid",
      authorPn: "15551234567@s.whatsapp.net",
      participants: [{ id: "789@lid", phoneNumber: "123@s.whatsapp.net" }],
    });
    await vi.waitFor(() => expect(observed).toHaveBeenCalledTimes(2));
    expect(observed.mock.calls[1]?.[0]).toMatchObject({
      kind: "participants_changed",
      action: "add",
      actorId: "456@lid",
      actorPhoneNumberId: "15551234567@s.whatsapp.net",
      participants: [{ id: "789@lid", phoneNumberId: "123@s.whatsapp.net" }],
    });
    expect(onMessage).not.toHaveBeenCalled();
    expect(sock.sendMessage).not.toHaveBeenCalled();

    const signal = observed.mock.calls[0]?.[1].signal as AbortSignal;
    sock.ev.emit("connection.update", { connection: "close" });
    await listener.onClose;
    expect(signal.aborted).toBe(true);
    await listener.close();
    sock.ev.emit("groups.upsert", [currentRoster]);
    sock.ev.emit("group-participants.update", { id: "123@g.us", action: "remove" });
    await settleInboundWork();
    expect(observed).toHaveBeenCalledTimes(2);
  });

  it("keeps unknown actors unknown and distinguishes removal from invitation", async () => {
    const observed = observeMembership();
    const { listener, sock } = await startInboxMonitor(vi.fn());
    onTestFinished(() => listener.close());
    sock.ev.emit("groups.upsert", [
      { ...groupMetadata({ subject: "New group", participants: [] }), owner: "456@lid" },
    ]);
    await vi.waitFor(() => expect(observed).toHaveBeenCalledTimes(1));
    expect(observed.mock.calls[0]?.[0]).toMatchObject({
      kind: "group_observed",
      actorId: undefined,
      actorPhoneNumberId: undefined,
    });
    sock.ev.emit("group-participants.update", {
      id: "123@g.us",
      action: "remove",
      participants: [{ id: "123@s.whatsapp.net" }],
    });
    await vi.waitFor(() => expect(observed).toHaveBeenCalledTimes(2));
    expect(observed.mock.calls[1]?.[0]).toMatchObject({
      kind: "participants_changed",
      action: "remove",
      actorId: undefined,
    });
    sock.ev.emit("groups.update", [{ id: "123@g.us", author: "456@lid", subject: "Renamed" }]);
    await settleInboundWork();
    expect(observed).toHaveBeenCalledTimes(2);
  });
});
