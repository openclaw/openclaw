// Imessage tests cover markdown format plugin behavior.
import { downgradeApprovalMarkdownToPlaintext } from "openclaw/plugin-sdk/approval-reply-runtime";
import { describe, expect, it } from "vitest";
import { extractMarkdownFormatRuns } from "./markdown-format.js";

const APPROVAL_ID = "a7a8b519-2311-4dcd-bccf-d6ca1d737969";
// The canonical exec approval prompt core emits, verbatim (RFC 0002 worked example).
const APPROVAL_PROMPT = [
  "Approval required.",
  "Run:",
  "```txt\n/approve " + APPROVAL_ID + " allow-once\n```",
  "Pending command:",
  '```sh\ncurl -sS -o /dev/null -w "%{http_code}" https://example.com\n```',
  `Host: gateway\nFull id: \`${APPROVAL_ID}\``,
].join("\n\n");

// RFC 0002 step 1: iMessage stays at the plaintext default, so the forwarder
// downgrades before send and the typed-run formatter then sees clean text.
// This proves the two step-1 criteria on the real prompt: no stray markers and
// no bold. Step 2 (#85954) flips iMessage to markdown and adds bold labels.
describe("iMessage approval prompt at the step-1 plaintext default", () => {
  const downgraded = downgradeApprovalMarkdownToPlaintext(APPROVAL_PROMPT);
  const { text, ranges } = extractMarkdownFormatRuns(downgraded);

  it("strips every code marker before the prompt reaches the send path", () => {
    expect(text).not.toContain("`");
  });

  it("produces no typed-run formatting, so nothing renders bold", () => {
    expect(ranges).toStrictEqual([]);
  });

  it("keeps the command, id, and approve instruction intact and copyable", () => {
    expect(text).toContain('curl -sS -o /dev/null -w "%{http_code}" https://example.com');
    expect(text).toContain(`/approve ${APPROVAL_ID} allow-once`);
    expect(text).toContain(APPROVAL_ID);
  });
});

describe("extractMarkdownFormatRuns", () => {
  it("returns the text unchanged when there is no markdown", () => {
    const { text, ranges } = extractMarkdownFormatRuns("plain text reply");
    expect(text).toBe("plain text reply");
    expect(ranges).toStrictEqual([]);
  });

  it("extracts a bold span", () => {
    const { text, ranges } = extractMarkdownFormatRuns("**bold** text");
    expect(text).toBe("bold text");
    expect(ranges).toEqual([{ start: 0, length: 4, styles: ["bold"] }]);
  });

  it("extracts mixed bold and italic", () => {
    const { text, ranges } = extractMarkdownFormatRuns("**hi** and *there*");
    expect(text).toBe("hi and there");
    expect(ranges).toEqual([
      { start: 0, length: 2, styles: ["bold"] },
      { start: 7, length: 5, styles: ["italic"] },
    ]);
  });

  it("extracts underline and strikethrough", () => {
    const { text, ranges } = extractMarkdownFormatRuns("__under__ and ~~strike~~");
    expect(text).toBe("under and strike");
    expect(ranges).toEqual([
      { start: 0, length: 5, styles: ["underline"] },
      { start: 10, length: 6, styles: ["strikethrough"] },
    ]);
  });

  it("respects word boundaries on single-underscore italics", () => {
    const { text, ranges } = extractMarkdownFormatRuns("snake_case_var ok");
    expect(text).toBe("snake_case_var ok");
    expect(ranges).toStrictEqual([]);
  });

  it("treats single-underscore as italic when surrounded by whitespace", () => {
    const { text, ranges } = extractMarkdownFormatRuns("a _word_ b");
    expect(text).toBe("a word b");
    expect(ranges).toEqual([{ start: 2, length: 4, styles: ["italic"] }]);
  });

  it("does not treat empty marker pairs as formatting", () => {
    const { text, ranges } = extractMarkdownFormatRuns("**  ** literal");
    expect(text).toBe("**  ** literal");
    expect(ranges).toStrictEqual([]);
  });

  it("leaves a lone asterisk alone", () => {
    const { text, ranges } = extractMarkdownFormatRuns("price * quantity");
    expect(text).toBe("price * quantity");
    expect(ranges).toStrictEqual([]);
  });

  it("computes ranges in output coordinates, not input", () => {
    const { text, ranges } = extractMarkdownFormatRuns("a **b** c **d** e");
    expect(text).toBe("a b c d e");
    expect(ranges).toEqual([
      { start: 2, length: 1, styles: ["bold"] },
      { start: 6, length: 1, styles: ["bold"] },
    ]);
  });

  it("parses ***triple-marker*** as bold + italic over the same span", () => {
    const { text, ranges } = extractMarkdownFormatRuns("***hi***");
    expect(text).toBe("hi");
    // Compound marker emits both styles over the same span.
    expect(ranges).toEqual([
      { start: 0, length: 2, styles: ["bold"] },
      { start: 0, length: 2, styles: ["italic"] },
    ]);
  });

  it("parses **bold _and underline_ together** as nested ranges", () => {
    const { text, ranges } = extractMarkdownFormatRuns("**bold _and underline_ together**");
    expect(text).toBe("bold and underline together");
    // Inner italic-via-_ at offset 5, length 13; outer bold over the full span.
    expect(ranges).toEqual([
      { start: 5, length: 13, styles: ["italic"] },
      { start: 0, length: 27, styles: ["bold"] },
    ]);
  });

  it("respects word boundaries on double-underscore underline", () => {
    const { text, ranges } = extractMarkdownFormatRuns("def __init__(self):");
    expect(text).toBe("def __init__(self):");
    expect(ranges).toStrictEqual([]);
  });

  it("does not leak literal asterisks from triple markers when intent is unclear", () => {
    // `***bold***` should never produce a bare `*` in the output text.
    const { text } = extractMarkdownFormatRuns("hello ***world***");
    expect(text).not.toMatch(/\*/);
  });
});
