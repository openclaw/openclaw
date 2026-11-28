import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateWAMessageFromContent, type proto } from "baileys";
import { expect, it } from "vitest";
import {
  describeReplyContext,
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
function nativeFlow(paramsJson: string, text?: string): proto.IMessage {
  return {
    interactiveResponseMessage: {
      body: text ? { text } : undefined,
      nativeFlowResponseMessage: { name: "single_select", paramsJson },
    },
  };
}
function ephemeral(message: proto.IMessage): proto.IMessage {
  return { ephemeralMessage: { message } };
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
it("resolves quoted LID sender to phone number via authDir mapping", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-wa-lid-test-"));
  try {
    fs.writeFileSync(
      path.join(tempDir, "lid-mapping-1234567890_reverse.json"),
      JSON.stringify("15555550123"),
    );
    const reply = describeReplyContext(
      extended({
        stanzaId: "q1",
        participant: "1234567890@lid",
        quotedMessage: { conversation: "hello" },
      }),
      { authDir: tempDir },
    );
    expect(reply?.sender).toMatchObject({
      lid: "1234567890@lid",
      e164: "+15555550123",
      label: "+15555550123",
    });
    const deviceScoped = describeReplyContext(
      extended({
        stanzaId: "q2",
        participant: "15555550123:2@s.whatsapp.net",
        quotedMessage: { conversation: "hello device" },
      }),
    );
    expect(deviceScoped?.sender).toMatchObject({
      jid: "15555550123@s.whatsapp.net",
      e164: "+15555550123",
      label: "+15555550123",
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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
  [nativeFlow("{}", "Continue"), "Continue"],
  [nativeFlow('{"id":"shipping-express","title":"Express shipping"}'), "Express shipping"],
  [{ pollCreationMessageV4: { message: poll } }, "Lunch?\n- Pizza\n- Sushi"],
  [{ ptvMessage: { caption: "Watch this", mimetype: "video/mp4" } }, "Watch this"],
])("extracts text from %j", (message, expected) => {
  expect(extractText(message)).toBe(expected);
});
it.each(["{", "[]"])("ignores invalid native-flow objects: %s", (json) => {
  expect(extractText(nativeFlow(json))).toBeUndefined();
});
it.each<[string, proto.IMessage | undefined, boolean]>([
  ["location", { locationMessage: { degreesLatitude: 1, degreesLongitude: 2 } }, true],
  [
    "wrapped button (#73797)",
    ephemeral({ buttonsResponseMessage: { selectedButtonId: "ok", selectedDisplayText: "OK" } }),
    true,
  ],
  ["missing (#73797)", undefined, false],
  ["receipt (#73797)", { senderKeyDistributionMessage: {} }, false],
  ["empty text", { extendedTextMessage: { text: "  " } }, false],
])("classifies %s user content", (_name, message, expected) => {
  expect(hasInboundUserContent(message)).toBe(expected);
});
