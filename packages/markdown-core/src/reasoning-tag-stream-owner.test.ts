import { describe, expect, it, vi } from "vitest";
import * as parser from "./reasoning-tag-parser.js";
import { createLiveReasoningTagStream } from "./reasoning-tag-stream-owner.js";

describe("canonical live reasoning owner", () => {
  it("extends a literal multiline tail before the closing tag", () => {
    const stream = createLiveReasoningTagStream();
    expect(stream.append("<think>first line\n")).toBe("first line");
    expect(stream.append("second line")).toBe("first line\nsecond line");
    expect(stream.append("</think>Answer")).toBe("first line\nsecond line");
    expect(stream.append("<think>later unfinished reasoning")).toBe("first line\nsecond line");
  });

  it("releases parser-proven quoted inline code without waiting for a reasoning close", () => {
    const stream = createLiveReasoningTagStream();
    expect(stream.append("<think>Use `")).toBe("Use");
    expect(stream.append("<think note='literal>")).toBe("Use");
    expect(stream.append("`.\n")).toBe("Use `<think note='literal>`.");
    expect(stream.append("<internal>PRIVATE_MARKER</internal></think>Answer")).toBe("");
  });

  it("releases a split tilde fence when canonical block ownership closes", () => {
    const stream = createLiveReasoningTagStream();
    stream.append("<think>Example\n~~~xml\n");
    stream.append("<internal>PUBLIC_LITERAL</internal>");
    expect(stream.append("\n~~~\n")).toBe(
      "Example\n~~~xml\n<internal>PUBLIC_LITERAL</internal>\n~~~",
    );
    expect(stream.append("<internal>PRIVATE_MARKER</internal></think>Answer")).toBe("");
  });

  it("keeps ordinary multiline lookahead work bounded without reparsing", () => {
    const stream = createLiveReasoningTagStream();
    const findNextLineEnding = parser.findNextLineEnding;
    let lineLookaheadWork = 0;
    const lineSpy = vi.spyOn(parser, "findNextLineEnding").mockImplementation((text, start) => {
      // Both CR and LF indexOf searches can visit the remaining suffix.
      lineLookaheadWork += 2 * (text.length - start);
      return findNextLineEnding(text, start);
    });
    const spies = [
      vi.spyOn(parser, "parseMarkdownOwnership"),
      vi.spyOn(parser, "parseReasoningTagAt"),
      vi.spyOn(parser, "scanReasoningTags"),
      vi.spyOn(parser, "scanStableReasoningTags"),
    ];
    try {
      stream.append("<think>first line\n");
      for (const spy of spies) {
        spy.mockClear();
      }
      let result = "";
      for (let index = 0; index < 2_000; index += 1) {
        result = stream.append("ordinary ");
      }
      expect(result).toBe("first line\n" + "ordinary ".repeat(2_000).trimEnd());
      expect(lineSpy).toHaveBeenCalled();
      expect(lineLookaheadWork).toBeLessThanOrEqual(
        4 * ("<think>first line\n".length + "ordinary ".length * 2_000),
      );
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      lineSpy.mockRestore();
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
  });
});
