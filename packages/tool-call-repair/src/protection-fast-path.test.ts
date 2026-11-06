import { describe, expect, it, vi } from "vitest";
import {
  advanceProtectionScanState,
  createProtectionScanState,
  resolveProtectionFastPath,
} from "./protection-fast-path.js";

function verdictFor(prefix: string, incoming: string) {
  const state = createProtectionScanState();
  advanceProtectionScanState(state, prefix);
  return resolveProtectionFastPath(state, incoming);
}

describe("protection fast path", () => {
  it("declines for tab-indented code", () => {
    expect(verdictFor("para\n\n", "\t[read]\n")).toBeUndefined();
    expect(verdictFor("", "\t[read]\n")).toBeUndefined();
    expect(verdictFor("para\n\n", "  \t[read]\n")).toBeUndefined();
    expect(verdictFor("para\n\n", "    \t[read]\n")).toBeUndefined();
    expect(verdictFor("para\n\n", "\t  [read]\n")).toBeUndefined();
  });

  it("declines when a bare carriage return ends a line", () => {
    expect(verdictFor("```\nliteral\n```\r", "[read]\n")).toBeUndefined();
    expect(verdictFor("```\r[read]\r", "[read]\n")).toBeUndefined();
    expect(verdictFor("```\nliteral\n", "```\r[read]\n")).toBeUndefined();
    expect(verdictFor("```toml\r\n", "[read]\r\n")?.(0)).toBe(true);
  });

  it("clears paragraph ambiguity at a blank line but never fence-parity doubt", () => {
    expect(verdictFor("a `code` b\n\nplain\n", "[read]\n")?.(0)).toBe(false);
    expect(verdictFor("- item\n```\n\nplain\n", "[read]\n")).toBeUndefined();
  });

  it("keeps successive lookups linear instead of rescanning from the start each time", () => {
    // A fresh scan for each candidate made lookup quadratic (#122513).
    const lineCount = 512;
    const body = Array.from({ length: lineCount }, (_, index) => `[read.${index}]`).join("\n");
    const incoming = `\`\`\`toml\n${body}\n\`\`\`\n`;
    const verdict = verdictFor("", incoming);
    if (!verdict) {
      throw new Error("Expected a protection verdict for fenced text");
    }

    let offset = 0;
    let comparisons = 0;
    // Observe numeric comparisons without exposing the closure's line index.
    const countedOffset = {
      [Symbol.toPrimitive]() {
        comparisons += 1;
        return offset;
      },
    };
    for (let index = 0; index < lineCount; index += 1) {
      expect(Reflect.apply(verdict, undefined, [countedOffset])).toBe(true);
      offset = incoming.indexOf("\n", offset) + 1;
    }

    expect(comparisons).toBeGreaterThan(0);
    expect(comparisons).toBeLessThanOrEqual(lineCount * 3);
  });

  it("advances a long newline-free stream in token-sized deltas without rescanning it", () => {
    // Rescanning partialLine for each small delta made newline-free streams quadratic (#122513).
    const state = createProtectionScanState();
    const chunk = "abcdefghij";
    const chunkCount = 512;
    const totalChars = chunk.length * chunkCount;
    let searchedChars = 0;
    // oxlint-disable-next-line typescript/unbound-method -- Invoked below with the original string receiver.
    const indexOf = String.prototype.indexOf;
    const searches = vi.spyOn(String.prototype, "indexOf").mockImplementation(function (
      this: string,
      search,
      position,
    ) {
      const result = indexOf.call(this, search, position);
      if (search === "\n") {
        searchedChars += (result === -1 ? this.length : result + 1) - (position ?? 0);
      }
      return result;
    });
    try {
      for (let index = 0; index < chunkCount; index += 1) {
        advanceProtectionScanState(state, chunk);
      }
    } finally {
      searches.mockRestore();
    }

    expect(state.partialLine).toBe(chunk.repeat(chunkCount));
    expect(searchedChars).toBeGreaterThan(0);
    expect(searchedChars).toBeLessThanOrEqual(totalChars * 2);
  });
});
