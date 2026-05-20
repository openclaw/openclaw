import { describe, expect, it } from "vitest";
import { matchGlob } from "./glob.js";

describe("matchGlob", () => {
  it("matches exact types", () => {
    expect(matchGlob("alarm.created", "alarm.created")).toBe(true);
    expect(matchGlob("alarm.created", "alarm.updated")).toBe(false);
  });

  it("matches wildcard suffix", () => {
    expect(matchGlob("alarm.*", "alarm.created")).toBe(true);
    expect(matchGlob("alarm.*", "workorder.created")).toBe(false);
  });

  it("matches hash segment", () => {
    expect(matchGlob("alarm.#", "alarm.created")).toBe(true);
    expect(matchGlob("alarm.#", "alarm.foo.bar")).toBe(false);
  });
});
