import type { GroupMetadata } from "baileys";
import { describe, expect, it, vi } from "vitest";
import {
  EXPECTED_WHATSAPP_GROUP_METADATA_CACHE_MAX_ENTRIES,
  nextMessageId,
  inboundMessage,
  groupMetadata,
  createBaileysCacheSupport,
  startInboxMonitorWithBaileysCache,
  expectCachedGroupMetadata,
  installStreamsInboundMessageHooks,
} from "./monitor-inbox.streams-inbound-messages.test-support.js";
import {
  buildNotifyMessageUpsert,
  getSock,
  settleInboundWork,
  startInboxMonitor,
  waitForMessageCalls,
  type InboxMonitorOptions,
  type InboxOnMessage,
} from "./monitor-inbox.test-harness.js";

describe("web monitor inbox metadata cache", () => {
  installStreamsInboundMessageHooks();

  function emitText(sock: ReturnType<typeof getSock>, id: string, group = true, text = "ping") {
    const upsert = buildNotifyMessageUpsert({
      id,
      remoteJid: group ? "123@g.us" : "999@s.whatsapp.net",
      text,
      participant: group ? "444@s.whatsapp.net" : undefined,
      timestamp: 1_700_000_000,
      pushName: group ? undefined : "Tester",
    });
    sock.ev.emit("messages.upsert", upsert);
  }

  function expectGroupSend(text: string, mentions?: string[], call = 1) {
    expect(getSock().sendMessage).toHaveBeenNthCalledWith(
      call,
      "123@g.us",
      mentions ? { text, mentions } : { text },
      expect.objectContaining({ messageId: expect.any(String) }),
    );
  }

  const phoneGroup = (subject: string) =>
    groupMetadata({ subject, participants: ["15551234567@s.whatsapp.net"] });
  const expectCacheMiss = (cache: ReturnType<typeof createBaileysCacheSupport>) =>
    expect(cache.socketOptions.cachedGroupMetadata("123@g.us")).resolves.toBeUndefined();

  it("group metadata cache omits group context when no group facts exist", async () => {
    const sock = getSock();
    sock.groupFetchAllParticipating.mockRejectedValueOnce(new Error("no groups"));
    const onMessage = vi.fn(async () => {});
    const { listener } = await startInboxMonitor(onMessage as InboxOnMessage);
    sock.groupMetadata.mockRejectedValueOnce(new Error("group metadata unavailable"));

    emitText(sock, nextMessageId("group-no-facts"));

    await waitForMessageCalls(onMessage, 1);
    const inbound = inboundMessage(onMessage);
    expect(inbound.admission?.conversation.kind).toBe("group");
    expect(inbound.group).toBeUndefined();

    await listener.close();
  });

  it("group metadata cache serves reconnect metadata after live fetch failures", async () => {
    const groupMetadataCache: NonNullable<InboxMonitorOptions["groupMetadataCache"]> = new Map();
    const onMessage = vi.fn(async (_msg: Parameters<InboxOnMessage>[0]) => {});

    const firstSock = getSock();
    firstSock.groupFetchAllParticipating.mockResolvedValueOnce({
      "123@g.us": groupMetadata({
        subject: "Recovered Group",
        participants: ["444@s.whatsapp.net"],
      }),
    });
    const first = await startInboxMonitor(onMessage as InboxOnMessage, { groupMetadataCache });
    await vi.waitFor(() =>
      expect(groupMetadataCache.get("123@g.us")?.subject).toBe("Recovered Group"),
    );
    expect(
      (groupMetadataCache.get("123@g.us") as Record<string, unknown>)?.participants,
    ).toBeUndefined();
    await first.listener.close();

    const second = await startInboxMonitor(onMessage as InboxOnMessage, { groupMetadataCache });
    second.sock.groupMetadata.mockRejectedValueOnce(new Error("408 timed out"));
    emitText(second.sock, nextMessageId("group-reconnect-cache"));

    await waitForMessageCalls(onMessage, 1);
    const inbound = inboundMessage(onMessage);
    expect(inbound.payload.body).toBe("ping");
    expect(inbound.admission?.conversation.id).toBe("123@g.us");
    expect(inbound.group?.subject).toBe("Recovered Group");
    expect(inbound.platform.senderE164).toBe("+444");
    expect(inbound.admission?.conversation.kind).toBe("group");
    expect(inbound.group?.participants).toBeUndefined();

    await second.listener.close();
  });

  it("group metadata cache refreshes provider snapshots that omit participant identities", async () => {
    const sock = getSock();
    sock.groupFetchAllParticipating.mockResolvedValueOnce({
      "123@g.us": groupMetadata({ subject: "Incomplete Group", participants: [] }),
    });
    sock.groupMetadata.mockResolvedValueOnce(phoneGroup("Complete Group"));

    const { listener, baileysCache } = await startInboxMonitorWithBaileysCache();
    try {
      await vi.waitFor(() => {
        expect(baileysCache.baileysGroupMetaCache.get("123@g.us")?.value.participants).toEqual([]);
      });

      await listener.sendMessage("123@g.us", "recovered @15551234567");

      expect(sock.groupMetadata).toHaveBeenCalledOnce();
      expectGroupSend("recovered @15551234567", ["15551234567@s.whatsapp.net"]);
      await expectCachedGroupMetadata(baileysCache, {
        id: "123@g.us",
        subject: "Complete Group",
        participants: [{ id: "15551234567@s.whatsapp.net" }],
      });
    } finally {
      await listener.close();
    }
  });
  it("group metadata cache never extends hydrated participant identities beyond their provider expiry", async () => {
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const sock = getSock();
    sock.groupFetchAllParticipating.mockResolvedValueOnce({
      "123@g.us": phoneGroup("Expiring Group"),
    });
    sock.groupMetadata.mockRejectedValue(new Error("408 timed out"));

    const { listener, baileysCache } = await startInboxMonitorWithBaileysCache();
    try {
      await vi.waitFor(() => {
        expect(baileysCache.baileysGroupMetaCache.get("123@g.us")?.expiresAt).toBe(
          1_700_000_300_000,
        );
      });

      dateNow.mockReturnValue(1_700_000_299_000);
      await listener.sendMessage("123@g.us", "fresh @15551234567");

      dateNow.mockReturnValue(1_700_000_300_001);
      await listener.sendMessage("123@g.us", "expired @15551234567");

      expectGroupSend("fresh @15551234567", ["15551234567@s.whatsapp.net"]);
      expectGroupSend("expired @15551234567", undefined, 2);
      expect(sock.groupMetadata).toHaveBeenCalledTimes(1);
      expect(baileysCache.baileysGroupMetaCache.has("123@g.us")).toBe(false);
    } finally {
      dateNow.mockRestore();
      await listener.close();
    }
  });

  it("group metadata cache drops hydrated local participants when membership changes", async () => {
    const sock = getSock();
    sock.groupFetchAllParticipating.mockResolvedValueOnce({
      "123@g.us": phoneGroup("Changing Group"),
    });
    const { listener, baileysCache } = await startInboxMonitorWithBaileysCache();
    try {
      await vi.waitFor(() => expect(baileysCache.baileysGroupMetaCache.has("123@g.us")).toBe(true));
      await listener.sendMessage("123@g.us", "before @15551234567");
      sock.groupMetadata.mockRejectedValue(new Error("408 timed out"));

      sock.ev.emit("group-participants.update", { id: "123@g.us" });
      await listener.sendMessage("123@g.us", "after @15551234567");

      expectGroupSend("before @15551234567", ["15551234567@s.whatsapp.net"]);
      expectGroupSend("after @15551234567", undefined, 2);
      expect(sock.groupMetadata).toHaveBeenCalledTimes(1);
      expect(baileysCache.baileysGroupMetaCache.has("123@g.us")).toBe(false);
    } finally {
      await listener.close();
    }
  });

  it.each(["lookup", "identity mapping"])(
    "does not republish sender-key recipients invalidated during %s",
    async (stage) => {
      const sock = getSock();
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const former = groupMetadata({
        subject: "Former Group",
        participants: ["277038292303944@lid"],
      });
      sock.groupMetadata.mockImplementationOnce(async () => {
        if (stage === "lookup") {
          entered.resolve();
          await resume.promise;
        }
        return former;
      });
      sock.signalRepository.lidMapping.getPNForLID.mockImplementationOnce(async () => {
        if (stage === "identity mapping") {
          entered.resolve();
          await resume.promise;
        }
        return "15551234567@s.whatsapp.net";
      });
      const { listener, baileysCache } = await startInboxMonitorWithBaileysCache();
      try {
        const sending = listener.sendMessage("123@g.us", "hello @15551234567");
        await entered.promise;
        sock.ev.emit("group-participants.update", { id: "123@g.us" });
        resume.resolve();
        await sending;
        // Baileys must miss the invalidated cache and fetch current recipients itself.
        await expectCacheMiss(baileysCache);
      } finally {
        resume.resolve();
        await listener.close();
      }
    },
  );

  it("does not republish sender-key recipients from invalidated startup hydration", async () => {
    const sock = getSock();
    const hydration = Promise.withResolvers<Record<string, GroupMetadata>>();
    sock.groupFetchAllParticipating.mockReturnValueOnce(hydration.promise);
    const { listener, baileysCache } = await startInboxMonitorWithBaileysCache();
    try {
      sock.ev.emit("group-participants.update", { id: "123@g.us" });
      hydration.resolve({
        "123@g.us": groupMetadata({ subject: "Former Group" }),
      });
      await settleInboundWork();
      await expectCacheMiss(baileysCache);
    } finally {
      await listener.close();
    }
  });

  it("group metadata cache never republishes a live fetch after its owner closes", async () => {
    const groupMetadataCache: NonNullable<InboxMonitorOptions["groupMetadataCache"]> = new Map();
    const sock = getSock();
    const metadata = Promise.withResolvers<GroupMetadata>();
    sock.groupMetadata.mockReturnValueOnce(metadata.promise);

    const { listener, baileysCache } = await startInboxMonitorWithBaileysCache({
      groupMetadataCache,
    });
    const sending = listener.sendMessage("123@g.us", "closed @15551234567").catch(() => undefined);
    await vi.waitFor(() => expect(sock.groupMetadata).toHaveBeenCalledOnce());

    await listener.close();
    metadata.resolve(phoneGroup("Closed Group"));
    await sending;

    expect(groupMetadataCache.has("123@g.us")).toBe(false);
    await expectCacheMiss(baileysCache);
  });

  it("group metadata cache invalidates partial group and participant updates", async () => {
    const groupMetadataCache: NonNullable<InboxMonitorOptions["groupMetadataCache"]> = new Map();
    const { listener, sock, baileysCache } = await startInboxMonitorWithBaileysCache({
      groupMetadataCache,
    });
    sock.ev.emit("groups.update", [
      groupMetadata({
        subject: "Fresh Group",
      }),
    ]);
    await expectCachedGroupMetadata(baileysCache, {
      id: "123@g.us",
      subject: "Fresh Group",
      participants: [{ id: "555@s.whatsapp.net" }],
    });
    expect(groupMetadataCache.has("123@g.us")).toBe(true);

    sock.ev.emit("groups.update", [{ id: "123@g.us" }]);
    expect(groupMetadataCache.has("123@g.us")).toBe(false);
    await expect(
      baileysCache.socketOptions.cachedGroupMetadata("123@g.us"),
    ).resolves.toBeUndefined();
    sock.ev.emit("groups.update", [
      groupMetadata({
        subject: "Fresh Again",
      }),
    ]);
    expect(groupMetadataCache.has("123@g.us")).toBe(true);
    sock.ev.emit("group-participants.update", { id: "123@g.us" });
    expect(groupMetadataCache.has("123@g.us")).toBe(false);
    await expect(
      baileysCache.socketOptions.cachedGroupMetadata("123@g.us"),
    ).resolves.toBeUndefined();

    await listener.close();
  });

  it("group metadata cache expires Baileys retry and metadata entries", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const baileysCache = createBaileysCacheSupport();
    const onMessage = vi.fn(async (_msg: Parameters<InboxOnMessage>[0]) => {});
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage, {
      recentMessageKeys: baileysCache.recentMessageKeys,
      baileysGroupMetaCache: baileysCache.baileysGroupMetaCache,
    });
    const messageId = nextMessageId("baileys-expiry");
    const key = { id: messageId, remoteJid: "999@s.whatsapp.net" };
    try {
      emitText(sock, messageId, false, "retry me");
      sock.ev.emit("groups.update", [groupMetadata({ subject: "Expiring Group" })]);
      await waitForMessageCalls(onMessage, 1);

      await expect(baileysCache.socketOptions.getMessage(key)).resolves.toEqual({
        conversation: "retry me",
      });
      await expectCachedGroupMetadata(baileysCache, {
        id: "123@g.us",
        subject: "Expiring Group",
        participants: [{ id: "555@s.whatsapp.net" }],
      });

      now.mockReturnValue(1_700_000_000_000 + 5 * 60 * 1000 + 1);
      await expectCacheMiss(baileysCache);

      now.mockReturnValue(1_700_000_000_000 + 10 * 60 * 1000 + 1);
      await expect(baileysCache.socketOptions.getMessage(key)).resolves.toBeUndefined();
    } finally {
      now.mockRestore();
      await listener.close();
    }
  });

  it("group metadata cache detaches Baileys listeners on close", async () => {
    const baileysCache = createBaileysCacheSupport();
    const { listener, sock } = await startInboxMonitor(vi.fn(async () => {}) as InboxOnMessage, {
      recentMessageKeys: baileysCache.recentMessageKeys,
      baileysGroupMetaCache: baileysCache.baileysGroupMetaCache,
    });

    expect(sock.ev.listenerCount("groups.upsert")).toBe(1);
    expect(sock.ev.listenerCount("groups.update")).toBe(1);
    expect(sock.ev.listenerCount("group-participants.update")).toBe(1);

    await listener.close();

    expect(sock.ev.listenerCount("groups.upsert")).toBe(0);
    expect(sock.ev.listenerCount("groups.update")).toBe(0);
    expect(sock.ev.listenerCount("group-participants.update")).toBe(0);
  });

  it("group metadata cache bounds reconnect entries", async () => {
    const groupMetadataCache: NonNullable<InboxMonitorOptions["groupMetadataCache"]> = new Map();
    const groups = Object.fromEntries(
      Array.from({ length: EXPECTED_WHATSAPP_GROUP_METADATA_CACHE_MAX_ENTRIES + 2 }, (_, index) => [
        `${index}@g.us`,
        {
          id: `${index}@g.us`,
          subject: `Group ${index}`,
          owner: undefined,
          participants: [],
        },
      ]),
    );
    const sock = getSock();
    sock.groupFetchAllParticipating.mockResolvedValueOnce(groups);

    const { listener } = await startInboxMonitor(vi.fn(async () => {}) as InboxOnMessage, {
      groupMetadataCache,
    });

    await vi.waitFor(() => {
      expect(groupMetadataCache.size).toBe(EXPECTED_WHATSAPP_GROUP_METADATA_CACHE_MAX_ENTRIES);
    });
    expect(groupMetadataCache.has("0@g.us")).toBe(false);
    expect(
      groupMetadataCache.has(`${EXPECTED_WHATSAPP_GROUP_METADATA_CACHE_MAX_ENTRIES + 1}@g.us`),
    ).toBe(true);

    await listener.close();
  });

  it("group metadata cache does not block inbound listeners during hydration", async () => {
    const sock = getSock();
    const hydration = Promise.withResolvers<Record<string, never>>();
    sock.groupFetchAllParticipating.mockReturnValueOnce(hydration.promise);
    const onMessage = vi.fn(async () => {});

    const { listener } = await startInboxMonitor(onMessage as InboxOnMessage);
    emitText(sock, nextMessageId("pending-hydration"), false);
    await waitForMessageCalls(onMessage, 1);

    hydration.resolve({});
    await listener.close();
  });
});
