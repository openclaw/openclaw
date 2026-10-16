import { describe, expect, it } from "vitest";
import { scanXmlishToolCall, utf8ByteLengthWithinLimit } from "./grammar.js";

describe("scanXmlishToolCall", () => {
  it.each([`<function=${"x".repeat(121)}`, `<function=read><parameter=${"x".repeat(121)}`])(
    "rejects invalid or ambiguous executable forms: %s",
    (raw) => {
      expect(scanXmlishToolCall(raw).kind).toBe("invalid");
    },
  );

  it("excludes a partial function close from the payload cap", () => {
    const body = " ".repeat(255_999);
    const prefix = `<function=read>${body}</func`;
    const scan = scanXmlishToolCall(prefix);

    expect(scan.kind).toBe("prefix");
    if (scan.kind !== "prefix" || !scan.candidate?.payload) {
      return;
    }
    expect(
      utf8ByteLengthWithinLimit(
        prefix,
        scan.candidate.payload.start,
        scan.candidate.payload.end,
        256_000,
      ),
    ).toBe(255_999);
    expect(scanXmlishToolCall(`${prefix}tion>`).kind).toBe("complete");
  });
});
