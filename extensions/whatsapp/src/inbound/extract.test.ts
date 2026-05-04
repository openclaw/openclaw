import type { proto } from "@whiskeysockets/baileys";
import { describe, expect, it } from "vitest";
import { describeReplyContextKey, extractMentionedJids } from "./extract.js";

describe("extractMentionedJids", () => {
  const botJid = "5511999999999@s.whatsapp.net";
  const otherJid = "5511888888888@s.whatsapp.net";

  it("returns direct mentions from the current message", () => {
    const message: proto.IMessage = {
      extendedTextMessage: {
        text: "Hey @bot",
        contextInfo: {
          mentionedJid: [botJid],
        },
      },
    };
    expect(extractMentionedJids(message)).toEqual([botJid]);
  });

  it("ignores mentionedJids from quoted messages", () => {
    const message: proto.IMessage = {
      extendedTextMessage: {
        text: "I agree",
        contextInfo: {
          // The quoted message originally @mentioned the bot, but the
          // current message does not — this should NOT leak through.
          quotedMessage: {
            extendedTextMessage: {
              text: "Hey @bot what do you think?",
              contextInfo: {
                mentionedJid: [botJid],
              },
            },
          },
        },
      },
    };
    expect(extractMentionedJids(message)).toBeUndefined();
  });

  it("returns direct mentions even when quoted message also has mentions", () => {
    const message: proto.IMessage = {
      extendedTextMessage: {
        text: "Hey @other",
        contextInfo: {
          mentionedJid: [otherJid],
          quotedMessage: {
            extendedTextMessage: {
              text: "Hey @bot",
              contextInfo: {
                mentionedJid: [botJid],
              },
            },
          },
        },
      },
    };
    // Should return only the direct mention, not the quoted one.
    expect(extractMentionedJids(message)).toEqual([otherJid]);
  });

  it("returns mentions from media message types", () => {
    const message: proto.IMessage = {
      imageMessage: {
        contextInfo: {
          mentionedJid: [botJid],
        },
      },
    };
    expect(extractMentionedJids(message)).toEqual([botJid]);
  });

  it("returns undefined for messages with no mentions", () => {
    const message: proto.IMessage = {
      extendedTextMessage: {
        text: "Just a regular message",
      },
    };
    expect(extractMentionedJids(message)).toBeUndefined();
  });

  it("returns undefined for undefined input", () => {
    expect(extractMentionedJids(undefined)).toBeUndefined();
  });

  it("deduplicates mentions across message types", () => {
    const message: proto.IMessage = {
      extendedTextMessage: {
        text: "Hey @bot",
        contextInfo: {
          mentionedJid: [botJid],
        },
      },
      imageMessage: {
        contextInfo: {
          mentionedJid: [botJid],
        },
      },
    };
    expect(extractMentionedJids(message)).toEqual([botJid]);
  });
});

describe("describeReplyContextKey", () => {
  it("captures reply metadata when WhatsApp omits the quoted message body", () => {
    const message: proto.IMessage = {
      extendedTextMessage: {
        text: "can u see the message in my inline reply?",
        contextInfo: {
          stanzaId: "orig-1",
          participant: "919022233366@s.whatsapp.net",
        },
      },
    };

    expect(describeReplyContextKey(message)).toEqual({
      id: "orig-1",
      sender: expect.objectContaining({
        jid: "919022233366@s.whatsapp.net",
        e164: "+919022233366",
        label: "+919022233366",
      }),
    });
  });
});
