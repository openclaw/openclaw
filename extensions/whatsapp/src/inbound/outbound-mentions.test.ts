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

describe("resolveWhatsAppOutboundMentions", () => {
  it("rewrites visible phone-number mentions to LIDs after escaped backticks", () => {
    expect(resolve("literal \\` ping @+5511976136970")).toEqual({
      text: "literal \\` ping @277038292303944",
      mentionedJids: ["277038292303944@lid"],
    });
  });

  it("uses resolved E.164 metadata when LID participant records omit phoneNumber", () => {
    expect(
      resolve("ping @15551234567", [{ id: "277038292303944@lid", e164: "+15551234567" }]),
    ).toEqual({
      text: "ping @277038292303944",
      mentionedJids: ["277038292303944@lid"],
    });
  });

  it("prefers explicit LID metadata over a phone JID id", () => {
    expect(
      resolve("ping @15551234567 and @277038292303944", [
        { id: "15551234567@s.whatsapp.net", lid: "277038292303944@lid" },
      ]),
    ).toEqual({
      text: "ping @277038292303944 and @277038292303944",
      mentionedJids: ["277038292303944@lid"],
    });
  });

  it("applies LID rewrites by match position while skipping code spans", () => {
    expect(
      resolve(
        [
          "visible @+5511976136970",
          "`inline @+5511976136970`",
          "```",
          "fenced @+5511976136970",
          "```",
          "again @+5511976136970",
        ].join("\n"),
        [{ id: "277038292303944:9@lid", phoneNumber: "5511976136970@s.whatsapp.net" }],
      ),
    ).toEqual({
      text: [
        "visible @277038292303944",
        "`inline @+5511976136970`",
        "```",
        "fenced @+5511976136970",
        "```",
        "again @277038292303944",
      ].join("\n"),
      mentionedJids: ["277038292303944@lid"],
    });
  });

  it.each(["Run `notify\n@+5511976136970", "Run ``notify ` @+5511976136970"])(
    "does not rewrite or mention phone numbers inside balanced or unterminated inline code: %j",
    (text) => {
      expect(
        resolve(text, [{ id: "277038292303944@lid", phoneNumber: "5511976136970@s.whatsapp.net" }]),
      ).toEqual({ text, mentionedJids: [] });
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
