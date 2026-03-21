import { describe, expect, it } from "vitest";
import { createQuotedMessageCache, normalizeQuotedMessage } from "./quoted-message-cache.js";

describe("normalizeQuotedMessage", () => {
  it("keeps the stored direct-chat jid for quoted replies", () => {
    const normalized = normalizeQuotedMessage({
      message: {
        key: {
          id: "msg-1",
          remoteJid: "1234567890@lid",
          remoteJidAlt: "1555@s.whatsapp.net",
          addressingMode: "lid",
          fromMe: false,
          participant: "1234567890@lid",
        },
        message: { conversation: "hello there" },
      },
      messageId: "msg-1",
      remoteJid: "1234567890@lid",
      isGroup: false,
    });

    expect(normalized).toEqual({
      key: {
        id: "msg-1",
        remoteJid: "1234567890@lid",
        remoteJidAlt: "1555@s.whatsapp.net",
        addressingMode: "lid",
        fromMe: false,
      },
      message: { conversation: "hello there" },
    });
  });

  it("preserves fromMe for self-chat quoted replies", () => {
    const normalized = normalizeQuotedMessage({
      message: {
        key: {
          id: "msg-self-1",
          remoteJid: "1555@s.whatsapp.net",
          fromMe: true,
        },
        message: { conversation: "note to self" },
      },
      messageId: "msg-self-1",
      remoteJid: "1555@s.whatsapp.net",
      isGroup: false,
    });

    expect(normalized).toEqual({
      key: {
        id: "msg-self-1",
        remoteJid: "1555@s.whatsapp.net",
        fromMe: true,
      },
      message: { conversation: "note to self" },
    });
  });

  it("preserves group participant identity while keeping the group jid", () => {
    const normalized = normalizeQuotedMessage({
      message: {
        key: {
          id: "msg-2",
          remoteJid: "120363158967464097@g.us",
          fromMe: false,
          participant: "1555@s.whatsapp.net",
        },
        message: { conversation: "group hello" },
      },
      messageId: "msg-2",
      remoteJid: "120363158967464097@g.us",
      participantJid: "1555@s.whatsapp.net",
      isGroup: true,
    });

    expect(normalized).toEqual({
      key: {
        id: "msg-2",
        remoteJid: "120363158967464097@g.us",
        fromMe: false,
        participant: "1555@s.whatsapp.net",
      },
      message: { conversation: "group hello" },
    });
  });
});

describe("createQuotedMessageCache", () => {
  it("resolves a remembered direct-chat message by normalized outbound jid", () => {
    const cache = createQuotedMessageCache();
    cache.remember({
      message: {
        key: {
          id: "msg-1",
          remoteJid: "1234567890@lid",
          fromMe: false,
        },
        message: { conversation: "hello there" },
      },
      messageId: "msg-1",
      remoteJid: "1234567890@lid",
      normalizedJid: "1555@s.whatsapp.net",
      isGroup: false,
    });

    expect(
      cache.resolve({
        jid: "1555@s.whatsapp.net",
        replyToId: "msg-1",
      }),
    ).toEqual({
      key: {
        id: "msg-1",
        remoteJid: "1555@s.whatsapp.net",
        remoteJidAlt: "1234567890@lid",
        fromMe: false,
      },
      message: { conversation: "hello there" },
    });
  });

  it("preserves extra Baileys key metadata after rebinding", () => {
    const cache = createQuotedMessageCache();
    cache.remember({
      message: {
        key: {
          id: "msg-1",
          remoteJid: "1234567890@lid",
          remoteJidAlt: "1555@s.whatsapp.net",
          addressingMode: "lid",
          fromMe: false,
        },
        message: { conversation: "hello there" },
      },
      messageId: "msg-1",
      remoteJid: "1234567890@lid",
      normalizedJid: "1555@s.whatsapp.net",
      isGroup: false,
    });

    expect(
      cache.resolve({
        jid: "1555@s.whatsapp.net",
        replyToId: "msg-1",
      }),
    ).toEqual({
      key: {
        id: "msg-1",
        remoteJid: "1555@s.whatsapp.net",
        remoteJidAlt: "1234567890@lid",
        addressingMode: "lid",
        fromMe: false,
      },
      message: { conversation: "hello there" },
    });
  });

  it("counts one direct-chat message with two JID aliases as one remembered entry", () => {
    const cache = createQuotedMessageCache({ limit: 1 });
    cache.remember({
      message: {
        key: {
          id: "msg-1",
          remoteJid: "1234567890@lid",
          fromMe: false,
        },
        message: { conversation: "hello there" },
      },
      messageId: "msg-1",
      remoteJid: "1234567890@lid",
      normalizedJid: "1555@s.whatsapp.net",
      isGroup: false,
    });

    expect(
      cache.resolve({
        jid: "1234567890@lid",
        replyToId: "msg-1",
      }),
    ).toEqual({
      key: {
        id: "msg-1",
        remoteJid: "1234567890@lid",
        fromMe: false,
      },
      message: { conversation: "hello there" },
    });
    expect(
      cache.resolve({
        jid: "1555@s.whatsapp.net",
        replyToId: "msg-1",
      }),
    ).toEqual({
      key: {
        id: "msg-1",
        remoteJid: "1555@s.whatsapp.net",
        remoteJidAlt: "1234567890@lid",
        fromMe: false,
      },
      message: { conversation: "hello there" },
    });
  });

  it("keeps group quotes on the group jid when resolving", () => {
    const cache = createQuotedMessageCache();
    cache.remember({
      message: {
        key: {
          id: "msg-2",
          remoteJid: "120363158967464097@g.us",
          fromMe: false,
          participant: "1234567890@lid",
        },
        message: { conversation: "group hello" },
      },
      messageId: "msg-2",
      remoteJid: "120363158967464097@g.us",
      normalizedJid: "120363158967464097@g.us",
      participantJid: "1234567890@lid",
      isGroup: true,
    });

    expect(
      cache.resolve({
        jid: "120363158967464097@g.us",
        replyToId: "msg-2",
      }),
    ).toEqual({
      key: {
        id: "msg-2",
        remoteJid: "120363158967464097@g.us",
        fromMe: false,
        participant: "1234567890@lid",
      },
      message: { conversation: "group hello" },
    });
  });

  it("does not resolve the same message id across unrelated chats", () => {
    const cache = createQuotedMessageCache();
    cache.remember({
      message: {
        key: {
          id: "msg-1",
          remoteJid: "1234567890@lid",
          fromMe: false,
        },
        message: { conversation: "hello there" },
      },
      messageId: "msg-1",
      remoteJid: "1234567890@lid",
      normalizedJid: "1555@s.whatsapp.net",
      isGroup: false,
    });

    expect(
      cache.resolve({
        jid: "9999@s.whatsapp.net",
        replyToId: "msg-1",
      }),
    ).toBeUndefined();
  });

  it("removes every alias when an older message is evicted", () => {
    const cache = createQuotedMessageCache({ limit: 1 });
    cache.remember({
      message: {
        key: {
          id: "msg-1",
          remoteJid: "1234567890@lid",
          fromMe: false,
        },
        message: { conversation: "hello there" },
      },
      messageId: "msg-1",
      remoteJid: "1234567890@lid",
      normalizedJid: "1555@s.whatsapp.net",
      isGroup: false,
    });
    cache.remember({
      message: {
        key: {
          id: "msg-2",
          remoteJid: "120363158967464097@g.us",
          fromMe: false,
          participant: "1555@s.whatsapp.net",
        },
        message: { conversation: "group hello" },
      },
      messageId: "msg-2",
      remoteJid: "120363158967464097@g.us",
      normalizedJid: "120363158967464097@g.us",
      participantJid: "1555@s.whatsapp.net",
      isGroup: true,
    });

    expect(
      cache.resolve({
        jid: "1234567890@lid",
        replyToId: "msg-1",
      }),
    ).toBeUndefined();
    expect(
      cache.resolve({
        jid: "1555@s.whatsapp.net",
        replyToId: "msg-1",
      }),
    ).toBeUndefined();
    expect(
      cache.resolve({
        jid: "120363158967464097@g.us",
        replyToId: "msg-2",
      }),
    ).toEqual({
      key: {
        id: "msg-2",
        remoteJid: "120363158967464097@g.us",
        fromMe: false,
        participant: "1555@s.whatsapp.net",
      },
      message: { conversation: "group hello" },
    });
  });
});
