import { describe, expect, it } from "vitest";
import { parseBuzzTarget } from "./target.js";

describe("Buzz targets", () => {
  it("rejects non-channel targets", () => {
    expect(() => parseBuzzTarget("general")).toThrow("channel UUID");
  });
});
