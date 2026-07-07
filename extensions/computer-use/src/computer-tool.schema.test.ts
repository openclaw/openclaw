import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { buildComputerInputParams } from "./computer-tool.runtime.js";
import { ComputerToolSchema } from "./computer-tool.schema.js";
import { resolveComputerUseConfig } from "./config.js";

const config = resolveComputerUseConfig({ screenshotMaxWidth: 1280 });

describe("computer tool schema", () => {
  it.each([
    { action: "screenshot" },
    { action: "move", coordinate: [100, 200] },
    {
      action: "drag",
      path: [
        [10, 20],
        [30, 40],
      ],
    },
    { action: "type", text: "hello" },
    { action: "scroll", scrollDirection: "down", scrollAmount: 4 },
  ])("accepts representative payload %#", (payload) => {
    expect(Value.Check(ComputerToolSchema, payload)).toBe(true);
  });

  it.each([
    {},
    { action: "launch_missiles" },
    { action: "move", coordinate: [100] },
    { action: "drag", path: [[10, 20]] },
    { action: "wait", duration: 0 },
  ])("rejects malformed payload %#", (payload) => {
    expect(Value.Check(ComputerToolSchema, payload)).toBe(false);
  });

  it.each([
    ["left_click", "left", 1],
    ["right_click", "right", 1],
    ["middle_click", "middle", 1],
    ["double_click", "left", 2],
    ["triple_click", "left", 3],
  ] as const)("maps %s to click(%s, %i)", (action, button, count) => {
    expect(buildComputerInputParams({ action, coordinate: [25, 50] }, config)).toEqual({
      action: "click",
      x: 25,
      y: 50,
      button,
      count,
      screenIndex: 0,
      refWidth: 1280,
    });
  });
});
