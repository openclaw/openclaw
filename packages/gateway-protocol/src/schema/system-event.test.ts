import { describe, expect, it } from "vitest";
import { validateSystemEventParams } from "./system-event.js";

describe("validateSystemEventParams", () => {
  it("accepts input activity values and explicit clearing", () => {
    expect(validateSystemEventParams({ text: "Node: mac", lastInputSeconds: 4 })).toBe(true);
    expect(validateSystemEventParams({ text: "Node: mac", lastInputSeconds: null })).toBe(true);
  });

  it("rejects invalid input activity values", () => {
    expect(validateSystemEventParams({ text: "Node: mac", lastInputSeconds: "4" })).toBe(false);
  });
});
