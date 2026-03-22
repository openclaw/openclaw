import { describe, expect, it } from "vitest";
import { extractMentionedJids } from "./extract.js";

describe("extractMentionedJids", () => {
  it("ignores mentionedJid carried only on quotedMessage context (reply-to-mention false positive)", () => {
    const raw = {
      extendedTextMessage: {
        text: "reply text",
        contextInfo: {
          quotedMessage: {
            extendedTextMessage: {
              contextInfo: { mentionedJid: ["15551234567@s.whatsapp.net"] },
            },
          },
        },
      },
    };
    expect(extractMentionedJids(raw as never)).toBeUndefined();
  });

  it("still returns top-level mentions on the reply itself", () => {
    const raw = {
      extendedTextMessage: {
        text: "@bot hi",
        contextInfo: {
          mentionedJid: ["15551234567@s.whatsapp.net"],
        },
      },
    };
    expect(extractMentionedJids(raw as never)).toEqual(["15551234567@s.whatsapp.net"]);
  });
});
