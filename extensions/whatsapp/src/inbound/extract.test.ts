import { generateWAMessageFromContent, type proto } from "baileys";
import { expect, it } from "vitest";
import {
  describeReplyContext,
  extractMediaKind,
  extractMentionedJids,
  extractText,
  hasInboundUserContent,
} from "./extract.js";

const SENDER = "15555550123@s.whatsapp.net";
const GROUP = "120363000000000000@g.us";
const BOT = "5511999999999@s.whatsapp.net";
const OTHER = "5511888888888@s.whatsapp.net";
const poll: proto.IMessage = {
  pollCreationMessageV3: {
    name: "Lunch?",
    options: [{ optionName: "Pizza" }, { optionName: "Sushi" }],
  },
};
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
const quotedMessage = extended({ mentionedJid: [BOT] }, "Hey @bot");
it.each<[proto.IMessage | undefined, string[] | undefined]>([
  [extended({ quotedMessage }, "I agree"), undefined],
  [extended({ mentionedJid: [OTHER, OTHER], quotedMessage }, "Hey @other"), [OTHER]],
  [undefined, undefined],
])("extracts only direct, unique mentions: %j", (message, expected) => {
  expect(extractMentionedJids(message)).toEqual(expected);
});
it("preserves unavailable reply references without inventing a sender", () => {
  expect(describeReplyContext(extended({ stanzaId: "original-message" }, "yes"))).toMatchObject({
    id: "original-message",
    body: "[quoted message unavailable]",
    sender: { label: "unknown sender" },
  });
});
it("does not invent replies from unrelated context metadata", () => {
  expect(describeReplyContext(extended({ participant: SENDER }))).toBeNull();
});
it("reads quoted polls encoded by Baileys", () => {
  const generated = generateWAMessageFromContent(GROUP, extended({}, "Choose pizza"), {
    userJid: SENDER,
    quoted: {
      key: { id: "original-poll", remoteJid: GROUP, participant: SENDER, fromMe: false },
      message: poll,
    },
  });
  expect(describeReplyContext(generated.message ?? undefined)).toMatchObject({
    id: "original-poll",
    body: "Lunch?\n- Pizza\n- Sushi",
    sender: { jid: SENDER },
  });
});
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
  [{ pollCreationMessageV4: { message: poll } }, "Lunch?\n- Pizza\n- Sushi"],
  [{ ptvMessage: { caption: "Watch this", mimetype: "video/mp4" } }, "Watch this"],
])("extracts text from %j", (message, expected) => {
  expect(extractText(message)).toBe(expected);
});
it.each(["{", "[]"])("ignores invalid native-flow objects: %s", (json) => {
  expect(extractText(nativeFlow(json))).toBeUndefined();
});
it("classifies captionless video notes as user content", () => {
  const message = { ptvMessage: { mimetype: "video/mp4" } };
  expect(extractMediaKind(message)).toBe("video");
  expect(hasInboundUserContent(message)).toBe(true);
});
it.each<[string, proto.IMessage | undefined, boolean]>([
  ["plain text", { conversation: "hello" }, true],
  ["image", { imageMessage: { mimetype: "image/png" } }, true],
  ["sticker", { stickerMessage: { mimetype: "image/webp" } }, true],
  ["location", { locationMessage: { degreesLatitude: 1, degreesLongitude: 2 } }, true],
  [
    "wrapped button (#73797)",
    {
      ephemeralMessage: {
        message: {
          buttonsResponseMessage: { selectedButtonId: "ok", selectedDisplayText: "OK" },
        },
      },
    },
    true,
  ],
  ["missing (#73797)", undefined, false],
  [
    "receipt (#73797)",
    {
      senderKeyDistributionMessage: {
        groupId: "g@example",
      } as unknown as proto.Message.ISenderKeyDistributionMessage,
    },
    false,
  ],
  ["empty text", { extendedTextMessage: { text: "  " } }, false],
])("classifies %s user content", (_name, message, expected) => {
  expect(hasInboundUserContent(message)).toBe(expected);
});
