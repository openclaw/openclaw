// Whatsapp tests cover web auto reply utils plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { createTestWebInboundMessage } from "../inbound/test-message.test-helper.js";
import type { AdmittedWebInboundMessage } from "../inbound/types.js";
import { isBotMentioned } from "./mentions.js";
import { isLikelyWhatsAppCryptoError } from "./util.js";

type TestMessageOverrides = {
  admission?: NonNullable<Parameters<typeof createTestWebInboundMessage>[0]>["admission"];
  body?: string;
  mentionedJids?: string[];
  selfE164?: string;
  selfJid?: string;
  selfLid?: string;
};

const makeMsg = (overrides: TestMessageOverrides): AdmittedWebInboundMessage => {
  const conversationId = overrides.admission?.conversation?.id ?? "120363401234567890@g.us";
  const conversationKind = overrides.admission?.conversation?.kind ?? "group";
  return createTestWebInboundMessage({
    event: { id: "m1" },
    payload: { body: overrides.body ?? "" },
    platform: {
      chatJid: conversationId,
      recipientJid: "15551234567@s.whatsapp.net",
      selfE164: overrides.selfE164,
      selfJid: overrides.selfJid,
      selfLid: overrides.selfLid,
    },
    admission: {
      ...overrides.admission,
      accountId: overrides.admission?.accountId ?? "default",
      conversation: {
        kind: conversationKind,
        id: conversationId,
        ...overrides.admission?.conversation,
      },
      sender: {
        id: conversationId,
        ...overrides.admission?.sender,
      },
      senderAccess: {
        reasonCode:
          conversationKind === "direct" ? "dm_policy_allowlisted" : "group_policy_allowed",
        ...overrides.admission?.senderAccess,
      },
    },
    group: {
      mentions: {
        jids: overrides.mentionedJids,
      },
    },
  });
};

describe("isBotMentioned", () => {
  function expectMentioned(
    msg: AdmittedWebInboundMessage,
    cfg: { mentionRegexes: RegExp[]; allowFrom?: Array<string | number>; isSelfChat?: boolean },
    expected: boolean,
  ) {
    expect(isBotMentioned(msg, cfg)).toBe(expected);
  }

  it("detects an explicit group @mention even when self is in allowFrom (#49317)", () => {
    // Operator config commonly puts their own E.164 in allowFrom so they can
    // run owner-only commands in groups; previously, that flipped the gate
    // to "self-chat mode" and silently dropped mention detection in groups,
    // including LID-style WhatsApp mentions that resolve to the bot's own
    // E.164. After the fix, group conversations honor the identity-overlap
    // check regardless of allowFrom.
    const cfg = { mentionRegexes: [/\bopenclaw\b/i], allowFrom: ["+15551234567"] };
    const msg = makeMsg({
      // Default `from` is the @g.us group JID from `makeMsg`.
      body: "@216372600647751 can you see this?",
      mentionedJids: ["216372600647751@lid"],
      selfE164: "+15551234567",
      selfJid: "15551234567@s.whatsapp.net",
      selfLid: "216372600647751@lid",
    });
    expectMentioned(msg, cfg, true);
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
    expectMentioned(msg, cfg, false);
  });
});

describe("resolveMentionTargets with @lid mapping", () => {
  it("uses @lid reverse mapping for mentions and self identity", async () => {
    await withTempDir("openclaw-lid-mapping-", async (authDir) => {
      await fs.writeFile(
        path.join(authDir, "lid-mapping-777_reverse.json"),
        JSON.stringify("+1777"),
      );

      const mentioned = isBotMentioned(
        makeMsg({
          body: "ping",
          mentionedJids: ["777@lid"],
          selfE164: "+1777",
          selfJid: "1777@s.whatsapp.net",
        }),
        { mentionRegexes: [] },
        authDir,
      );
      expect(mentioned).toBe(true);

      const mentionedByNumber = isBotMentioned(
        makeMsg({
          body: "1777 ping",
          selfJid: "777@lid",
        }),
        { mentionRegexes: [] },
        authDir,
      );
      expect(mentionedByNumber).toBe(true);
    });
  });
});

describe("web auto-reply util", () => {
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

    const cases: Array<{ name: string; value: unknown; expected: boolean }> = [
      { name: "returns false for non-matching Error", value: new Error("boom"), expected: false },
      { name: "returns false for non-matching string", value: "boom", expected: false },
      { name: "handles null reason without throwing", value: null, expected: false },
      { name: "handles bigint reason without throwing", value: 123n, expected: false },
      { name: "handles symbol reason without throwing", value: Symbol("bad mac"), expected: false },
      {
        name: "handles function reason without throwing",
        value: function namedFn() {},
        expected: false,
      },
    ];

    for (const testCase of cases) {
      it(testCase.name, () => {
        expect(isLikelyWhatsAppCryptoError(testCase.value)).toBe(testCase.expected);
      });
    }
  });
});
