import { describe, expect, it } from "vitest";
import { parseZulipTarget } from "./normalize.js";

describe("parseZulipTarget", () => {
  it("parses pm:<email>", () => {
    expect(parseZulipTarget("pm:Alice@Example.com")).toEqual({
      kind: "private",
      recipients: ["alice@example.com"],
    });
  });

  it("parses email shorthand as PM", () => {
    expect(parseZulipTarget("Bob@Example.com")).toEqual({
      kind: "private",
      recipients: ["bob@example.com"],
    });
  });

  it("parses stream:<stream>/<topic>", () => {
    expect(parseZulipTarget("stream:Engineering/Alerts")).toEqual({
      kind: "stream",
      stream: "Engineering",
      topic: "Alerts",
    });
  });

  it("parses <stream>#<topic> shorthand", () => {
    expect(parseZulipTarget("Engineering#Alerts")).toEqual({
      kind: "stream",
      stream: "Engineering",
      topic: "Alerts",
    });
  });
});
