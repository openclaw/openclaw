import { describe, expect, it } from "vitest";
import {
  resolveWhatsAppOutboundMentions,
  type WhatsAppOutboundMentionParticipant,
} from "./outbound-mentions.js";

function resolve(
  text: string,
  participants: WhatsAppOutboundMentionParticipant[] = [
    { id: "277038292303944:2@lid", phoneNumber: "5511976136970@s.whatsapp.net" },
  ],
  chatJid = "120363000000000000@g.us",
) {
  return resolveWhatsAppOutboundMentions({ chatJid, text, participants });
}

const LID = "277038292303944@lid";
function expectMention(
  text: string,
  participants: WhatsAppOutboundMentionParticipant[],
  expected: string,
) {
  expect(resolve(text, participants)).toEqual({ text: expected, mentionedJids: [LID] });
}

describe("resolveWhatsAppOutboundMentions", () => {
  it("rewrites visible phone-number mentions to LIDs after escaped backticks", () => {
    expect(resolve("literal \\` ping @+5511976136970")).toEqual({
      text: "literal \\` ping @277038292303944",
      mentionedJids: ["277038292303944@lid"],
    });
  });

  it("uses resolved E.164 metadata when LID participant records omit phoneNumber", () => {
    expectMention(
      "ping @15551234567",
      [{ id: LID, e164: "+15551234567" }],
      "ping @277038292303944",
    );
  });

  it("prefers explicit LID metadata over a phone JID id", () => {
    expectMention(
      "ping @15551234567 and @277038292303944",
      [{ id: "15551234567@s.whatsapp.net", lid: LID }],
      "ping @277038292303944 and @277038292303944",
    );
  });

  it("applies LID rewrites by match position while skipping code spans", () => {
    const code = "`inline @+5511976136970`\n```\nfenced @+5511976136970\n```";
    expectMention(
      `visible @+5511976136970\n${code}\nagain @+5511976136970`,
      [{ id: "277038292303944:9@lid", phoneNumber: "5511976136970@s.whatsapp.net" }],
      `visible @277038292303944\n${code}\nagain @277038292303944`,
    );
  });

  it.each(["Run `notify\n@+5511976136970", "Run ``notify ` @+5511976136970"])(
    "does not rewrite or mention phone numbers inside balanced or unterminated inline code: %j",
    (text) => {
      expect(resolve(text)).toEqual({ text, mentionedJids: [] });
    },
  );

  it("does not add mention metadata for direct chats or unmatched group participants", () => {
    expect(
      resolve(
        "hi @+15551234567",
        [{ id: "15551234567@s.whatsapp.net" }],
        "15551234567@s.whatsapp.net",
      ),
    ).toEqual({ text: "hi @+15551234567", mentionedJids: [] });
    expect(resolve("hi @+15551234567", [{ id: "15550000000@s.whatsapp.net" }])).toEqual({
      text: "hi @+15551234567",
      mentionedJids: [],
    });
  });
});
