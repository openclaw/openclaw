import { beforeEach, describe, expect, it, vi } from "vitest";

const recordChannelActivity = vi.hoisted(() => vi.fn());
let createWebSendApi: typeof import("./send-api.js").createWebSendApi;

vi.mock("openclaw/plugin-sdk/channel-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-runtime")>();
  return {
    ...actual,
    recordChannelActivity: (...args: unknown[]) => recordChannelActivity(...args),
  };
});

describe("createWebSendApi", () => {
  const sendMessage = vi.fn(async () => ({ key: { id: "msg-1" } }));
  const sendPresenceUpdate = vi.fn(async () => {});
  let api: ReturnType<typeof createWebSendApi>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    ({ createWebSendApi } = await import("./send-api.js"));
    api = createWebSendApi({
      sock: { sendMessage, sendPresenceUpdate },
      defaultAccountId: "main",
    });
  });

  it("uses sendOptions fileName for outbound documents", async () => {
    const payload = Buffer.from("pdf");
    await api.sendMessage("+1555", "doc", payload, "application/pdf", { fileName: "invoice.pdf" });
    expect(sendMessage).toHaveBeenCalledWith(
      "1555@s.whatsapp.net",
      expect.objectContaining({
        document: payload,
        fileName: "invoice.pdf",
        caption: "doc",
        mimetype: "application/pdf",
      }),
    );
    expect(recordChannelActivity).toHaveBeenCalledWith({
      channel: "whatsapp",
      accountId: "main",
      direction: "outbound",
    });
  });

  it("falls back to default document filename when fileName is absent", async () => {
    const payload = Buffer.from("pdf");
    await api.sendMessage("+1555", "doc", payload, "application/pdf");
    expect(sendMessage).toHaveBeenCalledWith(
      "1555@s.whatsapp.net",
      expect.objectContaining({
        document: payload,
        fileName: "file",
        caption: "doc",
        mimetype: "application/pdf",
      }),
    );
  });

  it("sends plain text messages", async () => {
    await api.sendMessage("+1555", "hello");
    expect(sendMessage).toHaveBeenCalledWith("1555@s.whatsapp.net", { text: "hello" });
    expect(recordChannelActivity).toHaveBeenCalledWith({
      channel: "whatsapp",
      accountId: "main",
      direction: "outbound",
    });
  });

  it("supports image media with caption", async () => {
    const payload = Buffer.from("img");
    await api.sendMessage("+1555", "cap", payload, "image/jpeg");
    expect(sendMessage).toHaveBeenCalledWith(
      "1555@s.whatsapp.net",
      expect.objectContaining({
        image: payload,
        caption: "cap",
        mimetype: "image/jpeg",
      }),
    );
  });

  it("supports audio as push-to-talk voice note", async () => {
    const payload = Buffer.from("aud");
    await api.sendMessage("+1555", "", payload, "audio/ogg", { accountId: "alt" });
    expect(sendMessage).toHaveBeenCalledWith(
      "1555@s.whatsapp.net",
      expect.objectContaining({
        audio: payload,
        ptt: true,
        mimetype: "audio/ogg",
      }),
    );
    expect(recordChannelActivity).toHaveBeenCalledWith({
      channel: "whatsapp",
      accountId: "alt",
      direction: "outbound",
    });
  });

  it("supports video media and gifPlayback option", async () => {
    const payload = Buffer.from("vid");
    await api.sendMessage("+1555", "cap", payload, "video/mp4", { gifPlayback: true });
    expect(sendMessage).toHaveBeenCalledWith(
      "1555@s.whatsapp.net",
      expect.objectContaining({
        video: payload,
        caption: "cap",
        mimetype: "video/mp4",
        gifPlayback: true,
      }),
    );
  });

  it("falls back to unknown messageId if Baileys result does not expose key.id", async () => {
    sendMessage.mockResolvedValueOnce({ key: {} as { id: string } });
    const res = await api.sendMessage("+1555", "hello");
    expect(res.messageId).toBe("unknown");
  });

  it("sends polls and records outbound activity", async () => {
    const res = await api.sendPoll("+1555", {
      question: "Q?",
      options: ["a", "b"],
      maxSelections: 2,
    });
    expect(sendMessage).toHaveBeenCalledWith(
      "1555@s.whatsapp.net",
      expect.objectContaining({
        poll: { name: "Q?", values: ["a", "b"], selectableCount: 2 },
      }),
    );
    expect(res.messageId).toBe("msg-1");
    expect(recordChannelActivity).toHaveBeenCalledWith({
      channel: "whatsapp",
      accountId: "main",
      direction: "outbound",
    });
  });

  it("sends reactions with participant JID normalization", async () => {
    await api.sendReaction("+1555", "msg-2", "👍", false, "+1999");
    expect(sendMessage).toHaveBeenCalledWith(
      "1555@s.whatsapp.net",
      expect.objectContaining({
        react: {
          text: "👍",
          key: expect.objectContaining({
            remoteJid: "1555@s.whatsapp.net",
            id: "msg-2",
            fromMe: false,
            participant: "1999@s.whatsapp.net",
          }),
        },
      }),
    );
  });

  it("sends composing presence updates to the recipient JID", async () => {
    await api.sendComposingTo("+1555");
    expect(sendPresenceUpdate).toHaveBeenCalledWith("composing", "1555@s.whatsapp.net");
  });

  it("sends media as document when mediaType is undefined", async () => {
    const mediaBuffer = Buffer.from("test");

    await api.sendMessage("123", "hello", mediaBuffer, undefined);

    expect(sendMessage).toHaveBeenCalledWith(
      "123@s.whatsapp.net",
      expect.objectContaining({
        document: mediaBuffer,
        mimetype: "application/octet-stream",
      }),
    );
  });

  it("does not set mediaType when mediaBuffer is absent", async () => {
    await api.sendMessage("123", "hello");

    expect(sendMessage).toHaveBeenCalledWith("123@s.whatsapp.net", { text: "hello" });
  });
});

describe("createWebSendApi — label operations", () => {
  const sendMessage = vi.fn(async () => ({ key: { id: "msg-1" } }));
  const sendPresenceUpdate = vi.fn(async () => {});
  const addChatLabel = vi.fn(async () => {});
  const removeChatLabel = vi.fn(async () => {});
  const getLabels = vi.fn(async () => [
    { id: "1", name: "New Customer", color: 0, deleted: false, predefinedId: "1" },
    { id: "6", name: "Hot Lead", color: 3, deleted: false },
  ]);
  const createLabel = vi.fn(async () => ({ id: "7", name: "Cold Lead", color: 5 }));

  const api = createWebSendApi({
    sock: {
      sendMessage,
      sendPresenceUpdate,
      addChatLabel,
      removeChatLabel,
      getLabels,
      createLabel,
    },
    defaultAccountId: "main",
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("addChatLabel normalizes JID and delegates to sock", async () => {
    await api.addChatLabel("+5215512345678", "6");
    expect(addChatLabel).toHaveBeenCalledWith("5215512345678@s.whatsapp.net", "6");
  });

  it("removeChatLabel normalizes JID and delegates to sock", async () => {
    await api.removeChatLabel("+5215512345678", "6");
    expect(removeChatLabel).toHaveBeenCalledWith("5215512345678@s.whatsapp.net", "6");
  });

  it("getLabels returns cached labels from sock", async () => {
    const labels = await api.getLabels();
    expect(getLabels).toHaveBeenCalled();
    expect(labels).toEqual([
      { id: "1", name: "New Customer", color: 0, deleted: false, predefinedId: "1" },
      { id: "6", name: "Hot Lead", color: 3, deleted: false },
    ]);
  });

  it("createLabel delegates to sock and returns new label", async () => {
    const result = await api.createLabel("Cold Lead", 5);
    expect(createLabel).toHaveBeenCalledWith("Cold Lead", 5);
    expect(result).toEqual({ id: "7", name: "Cold Lead", color: 5 });
  });

  it("getLabels returns empty array when sock.getLabels is undefined", async () => {
    const minimalApi = createWebSendApi({
      sock: { sendMessage, sendPresenceUpdate, addChatLabel, removeChatLabel },
      defaultAccountId: "main",
    });
    const labels = await minimalApi.getLabels();
    expect(labels).toEqual([]);
  });

  it("createLabel returns undefined when sock.createLabel is undefined", async () => {
    const minimalApi = createWebSendApi({
      sock: { sendMessage, sendPresenceUpdate, addChatLabel, removeChatLabel },
      defaultAccountId: "main",
    });
    const result = await minimalApi.createLabel("Test", 0);
    expect(result).toBeUndefined();
  });
});
