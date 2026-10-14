// Clickclack tests cover target plugin behavior.
import { describe, expect, it } from "vitest";
import { normalizeClickClackTarget, parseClickClackTarget } from "./target.js";

describe("ClickClack targets", () => {
  it("parses channel targets", () => {
    expect(parseClickClackTarget("channel:general")).toEqual({
      chatType: "group",
      kind: "channel",
      id: "general",
    });
    expect(normalizeClickClackTarget("general")).toBe("channel:general");
  });
});
