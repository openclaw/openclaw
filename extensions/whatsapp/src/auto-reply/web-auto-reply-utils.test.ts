import fs from "node:fs/promises";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { createTestWebInboundMessage } from "../inbound/test-message.test-helper.js";
import { isBotMentioned } from "./mentions.js";
import { isLikelyWhatsAppCryptoError } from "./util.js";

type TestMessageOverrides = {
  body?: string;
  mentionedJids?: string[];
  selfE164?: string;
  selfJid?: string;
  selfLid?: string;
};

const makeMsg = ({ body = "", mentionedJids, ...identity }: TestMessageOverrides) =>
  createTestWebInboundMessage({
    payload: { body },
    platform: identity,
    admission: { conversation: { kind: "group", id: "120363401234567890@g.us" } },
    group: { mentions: { jids: mentionedJids } },
  });

describe("isBotMentioned", () => {
  it("detects an explicit group @mention even when self is in allowFrom (#49317)", () => {
    // An allowlisted owner must not put group mentions into self-chat mode.
    const cfg = { mentionRegexes: [/\bopenclaw\b/i], allowFrom: ["+15551234567"] };
    const msg = makeMsg({
      body: "@216372600647751 can you see this?",
      mentionedJids: ["216372600647751@lid"],
      selfE164: "+15551234567",
      selfJid: "15551234567@s.whatsapp.net",
      selfLid: "216372600647751@lid",
    });
    expect(isBotMentioned(msg, cfg)).toBe(true);
  });

  it("honors explicit self-chat overrides without recomputing from allowFrom", () => {
    const cfg = {
      mentionRegexes: [/\bopenclaw\b/i],
      allowFrom: ["+15551230000"],
      isSelfChat: true,
    };
    const msg = makeMsg({
      body: "@owner ping",
      mentionedJids: ["999@s.whatsapp.net"],
      selfE164: "+999",
      selfJid: "999@s.whatsapp.net",
    });
    expect(isBotMentioned(msg, cfg)).toBe(false);
  });
});

it("uses @lid reverse mapping for mentions and self identity", async () => {
  await withTempDir("openclaw-lid-mapping-", async (authDir) => {
    await fs.writeFile(path.join(authDir, "lid-mapping-777_reverse.json"), JSON.stringify("+1777"));

    const mentionsBot = (message: TestMessageOverrides) =>
      isBotMentioned(makeMsg(message), { mentionRegexes: [] }, authDir);
    expect(
      mentionsBot({
        body: "ping",
        mentionedJids: ["777@lid"],
        selfE164: "+1777",
        selfJid: "1777@s.whatsapp.net",
      }),
    ).toBe(true);

    expect(mentionsBot({ body: "@1777 ping", selfJid: "777@lid" })).toBe(true);
  });
});

describe("isLikelyWhatsAppCryptoError", () => {
  it("recognizes authentication failures identified by the Baileys stack", () => {
    const error = new Error("Unsupported state or unable to authenticate data");
    error.stack = `${error.message}\n    at decrypt (noise-handler.js:10:2)`;
    expect(isLikelyWhatsAppCryptoError(error)).toBe(true);
    expect(isLikelyWhatsAppCryptoError(new Error(error.message))).toBe(false);
  });

  it("returns false for circular objects", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(isLikelyWhatsAppCryptoError(circular)).toBe(false);
  });

  it.each([
    ["non-matching Error", new Error("boom")],
    ["non-matching string", "boom"],
    ["null", null],
    ["bigint", 123n],
    ["symbol", Symbol("bad mac")],
    ["function", function namedFn() {}],
  ])("returns false for %s", (_name, value) => {
    expect(isLikelyWhatsAppCryptoError(value)).toBe(false);
  });
});
