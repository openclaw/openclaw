import { describe, expect, it } from "vitest";
import {
  consumeJsonToolClosingMarker,
  consumeLineBreak,
  END_TOOL_REQUEST,
  findBracketedJsonPayloadStart,
  findHarmonyJsonPayloadStart,
  findJsonObjectEnd,
  findXmlishToolCallEnd,
  HARMONY_CALL_MARKER,
  HARMONY_CHANNEL_MARKER,
  HARMONY_MESSAGE_MARKER,
  indexOfAsciiMarkerIgnoreCase,
  isPlainTextToolNameChar,
  isXmlishNameChar,
  matchesLiteralPrefix,
  skipHorizontalWhitespace,
  skipSerializedToolCallTrailingLineBreak,
  skipWhitespace,
  startsWithAsciiMarkerIgnoreCase,
} from "./grammar.js";

describe("END_TOOL_REQUEST", () => {
  it("equals [END_TOOL_REQUEST]", () => {
    expect(END_TOOL_REQUEST).toBe("[END_TOOL_REQUEST]");
  });
});

describe("HARMONY_CHANNEL_MARKER", () => {
  it("equals <|channel|>", () => {
    expect(HARMONY_CHANNEL_MARKER).toBe("<|channel|>");
  });
});

describe("HARMONY_MESSAGE_MARKER", () => {
  it("equals <|message|>", () => {
    expect(HARMONY_MESSAGE_MARKER).toBe("<|message|>");
  });
});

describe("HARMONY_CALL_MARKER", () => {
  it("equals <|call|>", () => {
    expect(HARMONY_CALL_MARKER).toBe("<|call|>");
  });
});

describe("matchesLiteralPrefix", () => {
  it("returns true when text equals literal", () => {
    expect(matchesLiteralPrefix("hello", "hello")).toBe(true);
  });

  it("returns true when text is a prefix of literal", () => {
    expect(matchesLiteralPrefix("hel", "hello")).toBe(true);
  });

  it("returns true when literal is a prefix of text", () => {
    expect(matchesLiteralPrefix("hello world", "hello")).toBe(true);
  });

  it("returns false when text does not match", () => {
    expect(matchesLiteralPrefix("xyz", "hello")).toBe(false);
  });

  it("handles single-character matching", () => {
    expect(matchesLiteralPrefix("a", "a")).toBe(true);
    expect(matchesLiteralPrefix("a", "b")).toBe(false);
  });

  it("handles empty text", () => {
    expect(matchesLiteralPrefix("", "hello")).toBe(true);
  });

  it("handles empty literal", () => {
    expect(matchesLiteralPrefix("hello", "")).toBe(true);
  });
});

describe("isPlainTextToolNameChar", () => {
  it("accepts letters, digits, underscore, hyphen", () => {
    expect(isPlainTextToolNameChar("a")).toBe(true);
    expect(isPlainTextToolNameChar("Z")).toBe(true);
    expect(isPlainTextToolNameChar("9")).toBe(true);
    expect(isPlainTextToolNameChar("_")).toBe(true);
    expect(isPlainTextToolNameChar("-")).toBe(true);
  });

  it("rejects special characters and whitespace", () => {
    expect(isPlainTextToolNameChar(".")).toBe(false);
    expect(isPlainTextToolNameChar(":")).toBe(false);
    expect(isPlainTextToolNameChar("@")).toBe(false);
    expect(isPlainTextToolNameChar("/")).toBe(false);
    expect(isPlainTextToolNameChar(" ")).toBe(false);
    expect(isPlainTextToolNameChar("\n")).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isPlainTextToolNameChar(undefined)).toBe(false);
  });
});

describe("isXmlishNameChar", () => {
  it("accepts letters, digits, underscore, hyphen, dot, colon", () => {
    expect(isXmlishNameChar("a")).toBe(true);
    expect(isXmlishNameChar("Z")).toBe(true);
    expect(isXmlishNameChar("9")).toBe(true);
    expect(isXmlishNameChar("_")).toBe(true);
    expect(isXmlishNameChar("-")).toBe(true);
    expect(isXmlishNameChar(".")).toBe(true);
    expect(isXmlishNameChar(":")).toBe(true);
  });

  it("rejects at-sign and whitespace", () => {
    expect(isXmlishNameChar("@")).toBe(false);
    expect(isXmlishNameChar(" ")).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isXmlishNameChar(undefined)).toBe(false);
  });
});

describe("skipHorizontalWhitespace", () => {
  it("skips spaces and tabs", () => {
    expect(skipHorizontalWhitespace("  \tabc", 0)).toBe(3);
  });

  it("stops at newline", () => {
    expect(skipHorizontalWhitespace(" \n x", 0)).toBe(1);
  });

  it("returns start when no whitespace", () => {
    expect(skipHorizontalWhitespace("abc", 0)).toBe(0);
  });

  it("handles empty string", () => {
    expect(skipHorizontalWhitespace("", 0)).toBe(0);
  });

  it("handles start past end", () => {
    expect(skipHorizontalWhitespace("abc", 10)).toBe(10);
  });
});

describe("skipWhitespace", () => {
  it("skips all whitespace characters", () => {
    expect(skipWhitespace(" \n\t\r x", 0)).toBe(5);
  });

  it("returns start when char is not whitespace", () => {
    expect(skipWhitespace("abc", 0)).toBe(0);
  });
});

describe("consumeLineBreak", () => {
  it("consumes \\n", () => {
    expect(consumeLineBreak("hello\nworld", 5)).toBe(6);
  });

  it("consumes \\r\\n", () => {
    expect(consumeLineBreak("hello\r\nworld", 5)).toBe(7);
  });

  it("consumes standalone \\r", () => {
    expect(consumeLineBreak("hello\rworld", 5)).toBe(6);
  });

  it("returns null when no line break", () => {
    expect(consumeLineBreak("hello world", 5)).toBeNull();
  });

  it("returns null when start is past end", () => {
    expect(consumeLineBreak("abc", 10)).toBeNull();
  });

  it("handles \\n at start", () => {
    expect(consumeLineBreak("\nabc", 0)).toBe(1);
  });
});

describe("findJsonObjectEnd", () => {
  it("finds end of simple JSON object", () => {
    expect(findJsonObjectEnd('{"a":1}', 0)).toBe(7);
  });

  // {"a":{"b":2}} -> chars: {"a":{"b":2}} = 13 chars (index 0-12, exclusive end 13)
  it("finds end of nested JSON object", () => {
    expect(findJsonObjectEnd('{"a":{"b":2}}', 0)).toBe(13);
  });

  // {"a":"\\u0041bc"} — JSON string with backslash-u0041 inside the string value.
  // The parser does not interpret JSON escapes; it only tracks brace balance and string boundaries.
  // \\ is escaped backslash in JSON, so the " after it closes the string, then bc"} ends the object.
  it("handles JSON with escaped backslash inside string", () => {
    expect(findJsonObjectEnd('{"a":"\\\\u0041bc"}', 0)).toBe(17);
  });

  it("handles backslash-escaped backslash inside strings", () => {
    expect(findJsonObjectEnd('{"a":"\\\\"}', 0)).toBe(10);
  });

  it("handles empty object", () => {
    expect(findJsonObjectEnd("{}", 0)).toBe(2);
  });

  it("returns null when object is not closed", () => {
    expect(findJsonObjectEnd('{"a":1', 0)).toBeNull();
  });

  it("returns null when exceeds maxPayloadBytes", () => {
    expect(findJsonObjectEnd('{"a":1}', 0, 3)).toBeNull();
  });

  it("honors maxPayloadBytes that is large enough", () => {
    expect(findJsonObjectEnd('{"a":1}', 0, 10)).toBe(7);
  });

  it("starts from given offset", () => {
    expect(findJsonObjectEnd('xx{"a":1}', 2)).toBe(9);
  });
});

describe("skipSerializedToolCallTrailingLineBreak", () => {
  it("skips trailing \\n", () => {
    expect(skipSerializedToolCallTrailingLineBreak("abc\n", 3)).toBe(4);
  });

  it("returns cursor when no line break", () => {
    expect(skipSerializedToolCallTrailingLineBreak("abc", 3)).toBe(3);
  });
});

describe("consumeJsonToolClosingMarker", () => {
  it("consumes END_TOOL_REQUEST", () => {
    const result = consumeJsonToolClosingMarker(
      `  ${END_TOOL_REQUEST}\n`,
      0,
    );
    expect(result).toBe(2 + END_TOOL_REQUEST.length + 1);
  });

  it("consumes bracketed close [/name]", () => {
    const result = consumeJsonToolClosingMarker("[/get_weather]\n", 0);
    expect(result).toBe("[/get_weather]\n".length);
  });

  it("consumes harmony call marker", () => {
    const result = consumeJsonToolClosingMarker("<|call|>\n", 0);
    expect(result).toBe(`${HARMONY_CALL_MARKER}\n`.length);
  });

  it("returns cursor when no marker found", () => {
    const result = consumeJsonToolClosingMarker("nothing here", 0);
    expect(result).toBe(0);
  });

  it("skips leading whitespace before marker", () => {
    const result = consumeJsonToolClosingMarker(`  ${END_TOOL_REQUEST}`, 0);
    expect(result).toBe(2 + END_TOOL_REQUEST.length);
  });
});

describe("findBracketedJsonPayloadStart", () => {
  it("finds JSON start after [tool_name]", () => {
    expect(findBracketedJsonPayloadStart("[get_weather]\n{")).toBe(
      "[get_weather]\n".length,
    );
  });

  it("returns null for non-bracket start", () => {
    expect(findBracketedJsonPayloadStart("hello")).toBeNull();
  });

  it("returns null when missing closing bracket", () => {
    expect(findBracketedJsonPayloadStart("[get_weather")).toBeNull();
  });

  it("returns null when JSON does not follow", () => {
    expect(findBracketedJsonPayloadStart("[get_weather]\nnot json")).toBeNull();
  });

  it("handles trailing \r\n before JSON", () => {
    expect(findBracketedJsonPayloadStart("[get_weather]\r\n{")).toBe(
      "[get_weather]\r\n".length,
    );
  });

  it("handles leading whitespace after bracket before JSON", () => {
    expect(findBracketedJsonPayloadStart("[get_weather]  \n  {")).toBe(
      "[get_weather]  \n  ".length,
    );
  });
});

describe("findHarmonyJsonPayloadStart", () => {
  it("finds JSON after full harmony header", () => {
    const header = `${HARMONY_CHANNEL_MARKER}commentary to=get_weather code`;
    const result = findHarmonyJsonPayloadStart(`${header} {`);
    expect(result).toBe(header.length + 1);
  });

  it("finds JSON without channel marker", () => {
    const result = findHarmonyJsonPayloadStart("analysis to=search code {");
    expect(result).toBe("analysis to=search code ".length);
  });

  it("finds JSON with optional message marker", () => {
    const header = `final to=search code ${HARMONY_MESSAGE_MARKER}`;
    const result = findHarmonyJsonPayloadStart(`${header} {`);
    expect(result).toBe(header.length + 1);
  });

  it("returns null for unknown channel", () => {
    expect(findHarmonyJsonPayloadStart("unknown to=foo code {")).toBeNull();
  });

  it("returns null when missing to=", () => {
    expect(findHarmonyJsonPayloadStart("commentary foo code {")).toBeNull();
  });

  it("returns null when to= has no tool name", () => {
    expect(
      findHarmonyJsonPayloadStart("commentary to= code {"),
    ).toBeNull();
  });

  it("returns null when missing code keyword", () => {
    expect(
      findHarmonyJsonPayloadStart("commentary to=get_weather foo {"),
    ).toBeNull();
  });

  it("returns null when JSON does not follow", () => {
    expect(
      findHarmonyJsonPayloadStart("commentary to=get_weather code notjson"),
    ).toBeNull();
  });

  it("handles channel commentary", () => {
    const result = findHarmonyJsonPayloadStart(
      `${HARMONY_CHANNEL_MARKER}commentary to=analyze code {`,
    );
    expect(result).not.toBeNull();
  });

  it("handles channel final", () => {
    const result = findHarmonyJsonPayloadStart(
      `${HARMONY_CHANNEL_MARKER}final to=summarize code {`,
    );
    expect(result).not.toBeNull();
  });
});

describe("startsWithAsciiMarkerIgnoreCase", () => {
  it("matches case-insensitively when marker is lowercase", () => {
    expect(startsWithAsciiMarkerIgnoreCase("Hello World", 0, "hello")).toBe(true);
    expect(startsWithAsciiMarkerIgnoreCase("HELLO World", 0, "hello")).toBe(true);
  });

  // The second argument is the *marker* — it is compared as-is against the lowercased text slice.
  it("returns false when marker is uppercase and text does not match uppercase literal", () => {
    expect(startsWithAsciiMarkerIgnoreCase("hello World", 0, "HELLO")).toBe(false);
  });

  it("returns false when no match", () => {
    expect(startsWithAsciiMarkerIgnoreCase("xyz", 0, "abc")).toBe(false);
  });

  it("handles marker longer than remaining text", () => {
    expect(startsWithAsciiMarkerIgnoreCase("ab", 0, "abc")).toBe(false);
  });

  it("respects the cursor offset", () => {
    expect(
      startsWithAsciiMarkerIgnoreCase("xx</function>", 2, "</function>"),
    ).toBe(true);
  });
});

describe("indexOfAsciiMarkerIgnoreCase", () => {
  it("finds marker at the start", () => {
    expect(indexOfAsciiMarkerIgnoreCase("</parameter>abc", "</parameter>", 0)).toBe(0);
  });

  it("finds marker case-insensitively", () => {
    expect(indexOfAsciiMarkerIgnoreCase("xx</PARAMETER>", "</parameter>", 0)).toBe(2);
  });

  it("returns -1 when not found", () => {
    expect(indexOfAsciiMarkerIgnoreCase("hello world", "</parameter>", 0)).toBe(-1);
  });

  it("returns -1 when marker is before the start offset", () => {
    // < is at index 2; from offset 3 there is no <
    expect(indexOfAsciiMarkerIgnoreCase("aa</parameter>bb", "</parameter>", 3)).toBe(-1);
  });

  it("finds marker at the end of text", () => {
    expect(indexOfAsciiMarkerIgnoreCase("prefix</parameter>", "</parameter>", 0)).toBe(6);
  });

  it("handles empty text", () => {
    expect(indexOfAsciiMarkerIgnoreCase("", "</parameter>", 0)).toBe(-1);
  });
});

describe("findXmlishToolCallEnd", () => {
  const parameterBlock = '<parameter=location>{"city":"NYC"}</parameter>';
  const functionClose = "</function>";

  function xmlBlock(params?: {
    functionName?: string;
    parameters?: string;
    closeTag?: string;
  }): string {
    const fn = params?.functionName ?? "get_weather";
    const p = params?.parameters ?? parameterBlock;
    const close = params?.closeTag ?? functionClose;
    return `<function=${fn}>${p}${close}`;
  }

  it("finds end of XML-ish tool call", () => {
    const text = xmlBlock();
    expect(findXmlishToolCallEnd(text)).toBe(text.length);
  });

  it("finds end of bracketed tool call with parameters", () => {
    const text = `[get_weather]\n${parameterBlock}${functionClose}`;
    expect(findXmlishToolCallEnd(text)).toBe(text.length);
  });

  it("finds end of tool: prefixed bracketed call", () => {
    const text = `[tool:get_weather]${parameterBlock}${functionClose}`;
    expect(findXmlishToolCallEnd(text)).toBe(text.length);
  });

  it("returns null for plain text", () => {
    expect(findXmlishToolCallEnd("hello world")).toBeNull();
  });

  it("returns null for function tag with no parameters", () => {
    expect(findXmlishToolCallEnd("<function=foo>< /function>")).toBeNull();
  });

  it("returns null when parameter has no close", () => {
    expect(
      findXmlishToolCallEnd(
        '<function=foo><parameter=bar>{"x":1}</parameter_not_close></function>',
      ),
    ).toBeNull();
  });

  it("handles multiple parameters", () => {
    const p1 = '<parameter=a>{"a":1}</parameter>';
    const p2 = '<parameter=b>{"b":2}</parameter>';
    const text = `<function=foo>${p1}${p2}</function>`;
    expect(findXmlishToolCallEnd(text)).toBe(text.length);
  });

  it("handles function close followed by more parameters (fallback)", () => {
    const p1 = '<parameter=a>val</parameter>';
    const text = `<function=foo>${p1}<parameter=b>val2</parameter>`;
    expect(findXmlishToolCallEnd(text)).not.toBeNull();
  });

  it("is case-insensitive for <function=...>", () => {
    const text = xmlBlock({ functionName: "GET_WEATHER" });
    expect(findXmlishToolCallEnd(text)).toBe(text.length);
  });

  // The function includes skipSerializedToolCallTrailingLineBreak, so it consumes the trailing \n
  it("handles trailing newline after function close", () => {
    const text = `${xmlBlock()}\n`;
    expect(findXmlishToolCallEnd(text)).toBe(text.length);
  });
});
