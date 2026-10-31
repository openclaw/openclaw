import { describe, expect, it } from "vitest";
import { scanXmlishToolCall } from "./grammar.js";

describe("scanXmlishToolCall", () => {
  it.each([`<function=${"x".repeat(121)}`, `<function=read><parameter=${"x".repeat(121)}`])(
    "rejects invalid or ambiguous executable forms: %s",
    (raw) => {
      expect(scanXmlishToolCall(raw).kind).toBe("invalid");
    },
  );
});
