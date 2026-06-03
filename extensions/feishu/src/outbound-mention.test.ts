import { describe, expect, it } from "vitest";
import { ensureMention, normalizeOutboundMentions, toCardMentions } from "./outbound-mention.js";

const ACC = "bot1";
const CHAT = "oc_chat1";

/** Stub lookup that resolves known names. */
function makeLookup(map: Record<string, string>) {
  return (name: string) => map[name] ?? map[name.toLowerCase()];
}

const lookup = makeLookup({
  alice: "ou_alice",
  bob: "ou_bob",
  "麦香鱼🦞": "ou_fish",
  麦香鱼: "ou_fish",
  龙虾一号: "ou_lobster",
  麦麦的龙虾一号: "ou_lobster",
});

function normalize(text: string, customLookup?: (name: string) => string | undefined) {
  return normalizeOutboundMentions({
    text,
    accountId: ACC,
    chatId: CHAT,
    lookup: customLookup ?? lookup,
  });
}

describe("L2 outbound mention normalization", () => {
  describe("Rule 1: already correct tags — pass through", () => {
    it("leaves correct <at user_id> tags unchanged", () => {
      const text = '<at user_id="ou_alice">Alice</at> hello';
      expect(normalize(text).text).toBe(text);
    });
  });

  describe("Rule 2: loose-quoted user_id variants", () => {
    it("fixes single-quoted user_id", () => {
      const result = normalize("<at user_id='ou_alice'>Alice</at> hi");
      expect(result.text).toBe('<at user_id="ou_alice">Alice</at> hi');
    });

    it("fixes unquoted user_id", () => {
      const result = normalize("<at user_id=ou_alice>Alice</at> hi");
      expect(result.text).toBe('<at user_id="ou_alice">Alice</at> hi');
    });

    it("fixes missing close tag (body captures remaining text up to next tag or EOL)", () => {
      const result = normalize("<at user_id=ou_alice>Alice hi");
      // Without </at>, the regex captures everything after > as the body.
      expect(result.text).toBe('<at user_id="ou_alice">Alice hi</at>');
    });
  });

  describe("Rule 3: card syntax <at id=...>", () => {
    it("converts card id syntax to user_id syntax", () => {
      const result = normalize("<at id=ou_alice></at> hi");
      expect(result.text).toBe('<at user_id="ou_alice">ou_alice</at> hi');
    });

    it("converts card id with name", () => {
      const result = normalize('<at id="ou_alice">Alice</at> hi');
      expect(result.text).toBe('<at user_id="ou_alice">Alice</at> hi');
    });
  });

  describe("Rule 4: @all variants", () => {
    it("standardizes <at user_id=all>", () => {
      const result = normalize('<at user_id="all">everyone</at>');
      expect(result.text).toBe('<at user_id="all">所有人</at>');
    });

    it("standardizes <at id=all>", () => {
      const result = normalize("<at id=all></at>");
      expect(result.text).toBe('<at user_id="all">所有人</at>');
    });
  });

  describe("Rule 5: JSON at tag leaked into text", () => {
    it("converts post JSON at tag", () => {
      const result = normalize('{"tag":"at","user_id":"ou_alice"} hello');
      expect(result.text).toBe('<at user_id="ou_alice">ou_alice</at> hello');
    });

    it("handles JSON with extra fields", () => {
      const result = normalize('{"tag":"at","user_id":"ou_alice","text":"Alice"} hi');
      expect(result.text).toBe('<at user_id="ou_alice">ou_alice</at> hi');
    });
  });

  describe("Rule 6: @ou_xxx raw openId", () => {
    it("converts @ou_xxx to proper tag", () => {
      const result = normalize("@ou_alice hello");
      expect(result.text).toBe('<at user_id="ou_alice">ou_alice</at> hello');
    });
  });

  describe("Rule 7: @Name natural language", () => {
    it("resolves @Name via registry lookup", () => {
      const result = normalize("@Alice hello");
      expect(result.text).toBe('<at user_id="ou_alice">Alice</at> hello');
      expect(result.failures).toEqual([]);
    });

    it("resolves Chinese names", () => {
      const result = normalize("@龙虾一号 你好");
      expect(result.text).toBe('<at user_id="ou_lobster">龙虾一号</at> 你好');
    });

    it("resolves names with emoji", () => {
      const result = normalize("@麦香鱼🦞 回答一下");
      expect(result.text).toBe('<at user_id="ou_fish">麦香鱼🦞</at> 回答一下');
    });

    it("preserves unresolved @Name and reports failure", () => {
      const result = normalize("@Unknown hello");
      expect(result.text).toBe("@Unknown hello");
      expect(result.failures).toEqual(["Unknown"]);
    });

    it("resolves multiple @Names in one message", () => {
      const result = normalize("@Alice 和 @Bob 你们好");
      expect(result.text).toBe(
        '<at user_id="ou_alice">Alice</at> 和 <at user_id="ou_bob">Bob</at> 你们好',
      );
    });
  });

  describe("skip regions", () => {
    it("does not process @Name inside inline code", () => {
      const result = normalize("use `@Alice` to mention");
      expect(result.text).toBe("use `@Alice` to mention");
    });

    it("does not process @Name inside fenced code blocks", () => {
      const result = normalize("```\n@Alice\n```");
      expect(result.text).toBe("```\n@Alice\n```");
    });

    it("does not process @ in email addresses", () => {
      const result = normalize("send to user@example.com");
      expect(result.text).toBe("send to user@example.com");
    });
  });

  describe("no-op cases", () => {
    it("returns unchanged text with no @ or <at", () => {
      const result = normalize("hello world");
      expect(result.text).toBe("hello world");
      expect(result.failures).toEqual([]);
    });

    it("returns unchanged empty text", () => {
      const result = normalize("");
      expect(result.text).toBe("");
    });
  });
});

describe("ensureMention", () => {
  it("prepends the canonical tag when the sender is not mentioned", () => {
    expect(ensureMention("好的，我准备好了", { openId: "ou_bot", name: "龙虾一号" })).toBe(
      '<at user_id="ou_bot">龙虾一号</at> 好的，我准备好了',
    );
  });

  it("is a no-op when the text already mentions that openId", () => {
    const text = '<at user_id="ou_bot">龙虾一号</at> 好的';
    expect(ensureMention(text, { openId: "ou_bot", name: "龙虾一号" })).toBe(text);
  });

  it("falls back to openId as display name when name is absent", () => {
    expect(ensureMention("hi", { openId: "ou_bot" })).toBe('<at user_id="ou_bot">ou_bot</at> hi');
  });

  it("returns a bare tag for empty text", () => {
    expect(ensureMention("", { openId: "ou_bot", name: "Bot" })).toBe(
      '<at user_id="ou_bot">Bot</at>',
    );
  });

  it("escapes < and > in the display name so the tag markup cannot break", () => {
    expect(ensureMention("hi", { openId: "ou_bot", name: "A<b>c</d>" })).toBe(
      '<at user_id="ou_bot">A&lt;b&gt;c&lt;/d&gt;</at> hi',
    );
  });

  it("emits the lark_md card form on card paths", () => {
    expect(ensureMention("好的", { openId: "ou_bot", name: "龙虾一号" }, { card: true })).toBe(
      "<at id=ou_bot></at> 好的",
    );
  });

  it("is a no-op when the card-form tag for that openId is already present", () => {
    const text = "<at id=ou_bot></at> 好的";
    expect(ensureMention(text, { openId: "ou_bot", name: "龙虾一号" }, { card: true })).toBe(text);
  });

  it("does NOT treat a text-form tag as satisfying a card path (it would not notify)", () => {
    // A `<at user_id>` tag inside a lark_md card does not notify the peer, so on
    // a card path ensureMention must still add the card-form tag.
    const text = '<at user_id="ou_bot">龙虾一号</at> 好的';
    expect(ensureMention(text, { openId: "ou_bot", name: "龙虾一号" }, { card: true })).toBe(
      `<at id=ou_bot></at> ${text}`,
    );
  });

  it("requires text-form on a text path even if a card-form tag is present", () => {
    const text = "<at id=ou_bot></at> 好的";
    expect(ensureMention(text, { openId: "ou_bot", name: "Bot" })).toBe(
      `<at user_id="ou_bot">Bot</at> ${text}`,
    );
  });
});

describe("toCardMentions", () => {
  it("rewrites text-form ou_ tags into the lark_md card form", () => {
    expect(toCardMentions('<at user_id="ou_bot">龙虾一号</at> 好的')).toBe(
      "<at id=ou_bot></at> 好的",
    );
  });

  it("converts every text-form mention in the text", () => {
    expect(toCardMentions('<at user_id="ou_a">A</at> 和 <at user_id="ou_b">B</at> 你们好')).toBe(
      "<at id=ou_a></at> 和 <at id=ou_b></at> 你们好",
    );
  });

  it("leaves an existing card-form tag unchanged", () => {
    expect(toCardMentions("<at id=ou_bot></at> hi")).toBe("<at id=ou_bot></at> hi");
  });

  it("leaves @all (user_id=all) untouched — only ou_ ids convert", () => {
    expect(toCardMentions('<at user_id="all">所有人</at> hi')).toBe(
      '<at user_id="all">所有人</at> hi',
    );
  });
});
