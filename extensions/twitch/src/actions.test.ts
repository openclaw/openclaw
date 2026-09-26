import { describe, expect, it } from "vitest";
import { twitchMessageActions } from "./actions.js";

describe("twitchMessageActions", () => {
  it("advertises sends for core execution", () => {
    expect(twitchMessageActions.describeMessageTool?.({ cfg: {} })).toEqual({ actions: ["send"] });
    expect(twitchMessageActions.supportsAction?.({ action: "send" })).toBe(true);
    expect(twitchMessageActions.supportsAction?.({ action: "poll" })).toBe(false);
  });

  it.each([
    {
      args: { to: " #channel ", message: " hello " },
      expected: { to: "#channel", message: "hello" },
    },
    { args: { to: "#channel", message: "---" }, expected: { to: "#channel", message: "---" } },
    { args: { to: 123, message: false }, expected: { to: "123", message: "false" } },
    { args: { to: "#channel", message: 0 }, expected: { to: "#channel", message: "0" } },
    { args: { to: "#channel", message: {} }, expected: null },
    { args: { to: "#channel", message: 1n }, expected: null },
    { args: { message: "hello" }, expected: null },
    { args: { to: "#channel", message: " " }, expected: null },
  ])("extracts send intent from $args", ({ args, expected }) => {
    expect(twitchMessageActions.extractToolSend?.({ args })).toEqual(expected);
  });
});
