import { describe, expect, it } from "vitest";
import { chunkTextForOutbound } from "./runtime-api.js";

describe("Matrix runtime API chunkTextForOutbound", () => {
  it("trims trailing whitespace from the final over-limit chunk", () => {
    expect(chunkTextForOutbound("alpha beta ", 8)).toEqual(["alpha", "beta"]);
  });
});
