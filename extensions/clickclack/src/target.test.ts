// Clickclack tests cover target plugin behavior.
import { describe, expect, it } from "vitest";
import {
  buildClickClackTarget,
  normalizeClickClackTarget,
  parseClickClackTarget,
} from "./target.js";

describe("ClickClack targets", () => {
  it("parses channel targets", () => {
    expect(parseClickClackTarget("channel:general")).toEqual({
      chatType: "group",
      kind: "channel",
      id: "general",
    });
    expect(parseClickClackTarget("ClickClack:Channel:General")).toEqual({
      chatType: "group",
      kind: "channel",
      id: "General",
    });
    expect(normalizeClickClackTarget("general")).toBe("channel:general");
    expect(normalizeClickClackTarget("CC:Channel:General")).toBe("channel:General");
  });

  it("parses thread and dm targets", () => {
    expect(buildClickClackTarget(parseClickClackTarget("thread:msg_1"))).toBe("thread:msg_1");
    expect(buildClickClackTarget(parseClickClackTarget("clickclack:Thread:msg_1"))).toBe(
      "thread:msg_1",
    );
    expect(parseClickClackTarget("dm:usr_1")).toEqual({
      chatType: "direct",
      kind: "dm",
      id: "usr_1",
    });
    expect(parseClickClackTarget("CC:DM:usr_1")).toEqual({
      chatType: "direct",
      kind: "dm",
      id: "usr_1",
    });
  });
});
