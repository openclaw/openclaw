import { describe, expect, it } from "vitest";
import {
  advanceProtectionScanState,
  createProtectionScanState,
  resolveProtectionFastPath,
} from "./protection-fast-path.js";

/** Feeds prior visible text, then asks the fast path about the next delta. */
function verdictFor(prefix: string, incoming: string) {
  const state = createProtectionScanState();
  advanceProtectionScanState(state, prefix);
  return resolveProtectionFastPath(state, incoming);
}

describe("protection fast path", () => {
  it("closes a fence only on a matching delimiter run", () => {
    expect(verdictFor("```\ninside\n~~~\n", "[read]\n")?.(0)).toBe(true);
    expect(verdictFor("````\ninside\n```\n", "[read]\n")?.(0)).toBe(true);
    expect(verdictFor("```\ninside\n```\n", "[read]\n")?.(0)).toBe(false);
  });

  it("declines when a backtick fence carries a backtick in its info string", () => {
    // Backticks in a backtick info string leave fence parity unknown.
    expect(verdictFor("```` ```\n", "[read]\n")).toBeUndefined();
    expect(verdictFor("```js`\n", "[read]\n")).toBeUndefined();
  });

  it("keeps tracking a tilde fence whose info string carries a backtick", () => {
    expect(verdictFor("~~~ js`\n", "[read]\n")?.(0)).toBe(true);
  });

  it("treats only spaces and tabs as closing-fence padding", () => {
    // CommonMark does not accept Unicode whitespace after a closing delimiter.
    expect(verdictFor("```\nliteral\n```\u00a0\n", "[read]\n")?.(0)).toBe(true);
    expect(verdictFor("```\nliteral\n```\t\n", "[read]\n")?.(0)).toBe(false);
    expect(verdictFor("```\nliteral\n```  \n", "[read]\n")?.(0)).toBe(false);
  });

  it("does not treat a Unicode-space line as blank", () => {
    // A U+00A0 line does not end a paragraph, so ambiguity must survive it.
    expect(verdictFor("a `code` b\n\u00a0\n", "[read]\n")).toBeUndefined();
  });

  it("declines for shapes it does not model", () => {
    expect(verdictFor("a `code` b\n", "[read]\n")).toBeUndefined();
    expect(verdictFor("> quoted\n", "[read]\n")).toBeUndefined();
    expect(verdictFor("- item\n", "[read]\n")).toBeUndefined();
    expect(verdictFor("para\n\n", "    [read]\n")).toBeUndefined();
  });

  it("declines for tab-indented code", () => {
    // CommonMark expands a leading tab to four columns of indentation.
    expect(verdictFor("para\n\n", "\t[read]\n")).toBeUndefined();
    expect(verdictFor("", "\t[read]\n")).toBeUndefined();
    expect(verdictFor("para\n\n", "  \t[read]\n")).toBeUndefined();
    // Four spaces followed by a tab still count as indented code.
    expect(verdictFor("para\n\n", "    \t[read]\n")).toBeUndefined();
    expect(verdictFor("para\n\n", "\t  [read]\n")).toBeUndefined();
  });

  it("declines for an unfinished line outside a fence", () => {
    expect(verdictFor("plain\n", "[read]")).toBeUndefined();
  });

  it("declines when a bare carriage return ends a line", () => {
    // Bare CR ends a CommonMark line, but this tracker only splits on LF.
    expect(verdictFor("```\nliteral\n```\r", "[read]\n")).toBeUndefined();
    expect(verdictFor("```\r[read]\r", "[read]\n")).toBeUndefined();
    expect(verdictFor("```\nliteral\n", "```\r[read]\n")).toBeUndefined();
    // CRLF is still tracked normally.
    expect(verdictFor("```toml\r\n", "[read]\r\n")?.(0)).toBe(true);
  });

  it("clears paragraph ambiguity at a blank line but never fence-parity doubt", () => {
    // An inline span cannot cross a blank line, so tracking resumes.
    expect(verdictFor("a `code` b\n\nplain\n", "[read]\n")?.(0)).toBe(false);
    // A delimiter that could not be classified leaves parity unknown for good.
    expect(verdictFor("- item\n```\n\nplain\n", "[read]\n")).toBeUndefined();
  });

  it("answers successive increasing offsets correctly, including a query before the first line", () => {
    // Queries follow the increasing offsets used by findPotentialCallStart.
    const verdict = verdictFor(
      "",
      ["plain", "```toml", "[a]", "[b]", "```", "plain2"].join("\n") + "\n",
    );
    const plainLen = "plain\n".length;
    const fenceOpenLen = plainLen + "```toml\n".length;
    const aLineStart = fenceOpenLen;
    const bLineStart = aLineStart + "[a]\n".length;
    const fenceCloseStart = bLineStart + "[b]\n".length;
    const plain2Start = fenceCloseStart + "```\n".length;

    expect(verdict?.(0)).toBe(false);
    // The fence-opening delimiter line itself sits inside the code region it opens.
    expect(verdict?.(plainLen)).toBe(true);
    expect(verdict?.(aLineStart)).toBe(true);
    expect(verdict?.(bLineStart)).toBe(true);
    expect(verdict?.(fenceCloseStart)).toBe(true);
    expect(verdict?.(plain2Start)).toBe(false);
  });

  it("keeps successive lookups linear instead of rescanning from the start each time", () => {
    // A fresh scan for each candidate made lookup quadratic (#122513).
    const lineCount = 20_000;
    const body = Array.from({ length: lineCount }, (_, index) => `[read.${index}]`).join("\n");
    const incoming = `\`\`\`toml\n${body}\n\`\`\`\n`;
    const verdict = verdictFor("", incoming);
    expect(verdict).toBeDefined();

    let offset = 0;
    const start = performance.now();
    for (let index = 0; index < lineCount; index += 1) {
      verdict?.(offset);
      offset = incoming.indexOf("\n", offset) + 1;
    }
    const elapsedMs = performance.now() - start;

    // Distinguish quadratic rescanning from a linear cursor.
    expect(elapsedMs).toBeLessThan(50);
  });

  it("advances a long newline-free stream in token-sized deltas without rescanning it", () => {
    // Rescanning partialLine for each small delta made newline-free streams quadratic (#122513).
    const state = createProtectionScanState();
    const chunk = "abcdefghij";
    const chunkCount = 40_000; // 400 KB in provider-sized deltas.
    const start = performance.now();
    for (let index = 0; index < chunkCount; index += 1) {
      advanceProtectionScanState(state, chunk);
    }
    const elapsedMs = performance.now() - start;

    expect(state.partialLine.length).toBe(chunk.length * chunkCount);
    expect(elapsedMs).toBeLessThan(200);
  });
});
