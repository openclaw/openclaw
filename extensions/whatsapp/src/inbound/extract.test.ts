import { generateWAMessageFromContent, type proto } from "baileys";
import { describe, expect, it } from "vitest";
import {
  describeReplyContext,
  extractMediaKind,
  extractMentionedJids,
  extractText,
  hasInboundUserContent,
} from "./extract.js";

function extended(contextInfo: proto.IContextInfo, text = "hello"): proto.IMessage {
  return { extendedTextMessage: { text, contextInfo } };
}

function nativeFlow(paramsJson: string): proto.IMessage {
  return {
    interactiveResponseMessage: {
      nativeFlowResponseMessage: { name: "single_select", paramsJson },
    },
  };
}

function expectUserContent(message: proto.IMessage | undefined, expected = true) {
  expect(hasInboundUserContent(message)).toBe(expected);
}

describe("extractMentionedJids", () => {
  const botJid = "5511999999999@s.whatsapp.net";
  const otherJid = "5511888888888@s.whatsapp.net";
  const quotedMessage = extended({ mentionedJid: [botJid] }, "Hey @bot");

  it("ignores mentionedJids from quoted messages", () => {
    const message = extended({ quotedMessage }, "I agree");
    expect(extractMentionedJids(message)).toBeUndefined();
  });

  it("returns direct mentions even when quoted message also has mentions", () => {
    const message = extended({ mentionedJid: [otherJid, otherJid], quotedMessage }, "Hey @other");
    expect(extractMentionedJids(message)).toEqual([otherJid]);
  });

  it("returns undefined for undefined input", () => {
    expect(extractMentionedJids(undefined)).toBeUndefined();
  });
});

describe("describeReplyContext", () => {
  it("preserves an unavailable reply reference without a quoted sender", () => {
    expect(describeReplyContext(extended({ stanzaId: "original-message" }, "yes"))).toMatchObject({
      id: "original-message",
      body: "[quoted message unavailable]",
      sender: { label: "unknown sender" },
    });
  });

  it("does not invent a reply from unrelated context metadata", () => {
    expect(
      describeReplyContext(extended({ participant: "15555550123@s.whatsapp.net" })),
    ).toBeNull();
  });

  it("preserves a quoted poll encoded through the real Baileys message generator", () => {
    const userJid = "15555550123@s.whatsapp.net";
    const generated = generateWAMessageFromContent(
      "120363000000000000@g.us",
      { extendedTextMessage: { text: "Choose pizza" } },
      {
        userJid,
        quoted: {
          key: {
            id: "original-poll",
            remoteJid: "120363000000000000@g.us",
            participant: userJid,
            fromMe: false,
          },
          message: {
            pollCreationMessageV3: {
              name: "Lunch?",
              options: [{ optionName: "Pizza" }, { optionName: "Sushi" }],
            },
          },
        },
      },
    );

    expect(describeReplyContext(generated.message ?? undefined)).toMatchObject({
      id: "original-poll",
      body: "Lunch?\n- Pizza\n- Sushi",
      sender: { jid: userJid },
    });
  });
});

describe("extractText", () => {
  it.each<[proto.IMessage, string]>([
    [
      { listResponseMessage: { title: "Option A", singleSelectReply: { selectedRowId: "a" } } },
      "Option A",
    ],
    [{ templateButtonReplyMessage: { selectedId: "button-1" } }, "button-1"],
    [
      {
        interactiveResponseMessage: {
          body: { text: "Continue" },
          nativeFlowResponseMessage: { name: "single_select", paramsJson: "{}" },
        },
      },
      "Continue",
    ],
    [nativeFlow('{"id":"shipping-express","title":"Express shipping"}'), "Express shipping"],
    [
      {
        pollCreationMessageV4: {
          message: {
            pollCreationMessageV3: { name: "Lunch?", options: [{ optionName: "Pizza" }] },
          },
        },
      },
      "Lunch?\n- Pizza",
    ],
    [{ ptvMessage: { caption: "Watch this", mimetype: "video/mp4" } }, "Watch this"],
  ])("extracts inbound text %j as %s", (message, expected) => {
    expect(extractText(message)).toBe(expected);
  });

  it("ignores malformed native-flow response JSON", () => {
    expect(extractText(nativeFlow("{"))).toBeUndefined();
  });

  it("ignores non-record native-flow response JSON", () => {
    expect(extractText(nativeFlow("[]"))).toBeUndefined();
  });
});

describe("hasInboundUserContent", () => {
  it("returns true for plain text conversation", () => {
    expectUserContent({ conversation: "hello" });
  });

  it("returns true for image message", () => {
    expectUserContent({ imageMessage: { mimetype: "image/png" } });
  });

  it("classifies captionless video notes as user-visible video media", () => {
    const message = { ptvMessage: { mimetype: "video/mp4" } } as proto.IMessage;

    expect(extractMediaKind(message)).toBe("video");
    expectUserContent(message);
  });

  it("returns true for sticker message", () => {
    expectUserContent({ stickerMessage: { mimetype: "image/webp" } });
  });

  it("returns true for location message with valid coords", () => {
    expectUserContent({ locationMessage: { degreesLatitude: 1, degreesLongitude: 2 } });
  });

  it("returns true for buttons response wrapped in ephemeralMessage (regression for #73797 + greptile review)", () => {
    expectUserContent({
      ephemeralMessage: {
        message: {
          buttonsResponseMessage: {
            selectedButtonId: "ok",
            selectedDisplayText: "OK",
          },
        },
      },
    });
  });

  it("returns false for undefined message (regression for #73797)", () => {
    expectUserContent(undefined, false);
  });

  it("returns false for receipt-style senderKeyDistribution-only payload (regression for #73797)", () => {
    expectUserContent(
      {
        senderKeyDistributionMessage: {
          groupId: "g@example",
        } as unknown as proto.Message.ISenderKeyDistributionMessage,
      },
      false,
    );
  });

  it("returns false when extendedTextMessage has only empty text", () => {
    expectUserContent({ extendedTextMessage: { text: "  " } }, false);
  });
});
