import { describe, expect, it } from "vitest";
import { resolveA2aTarget } from "./a2a-peers.js";

describe("resolveA2aTarget", () => {
  it("passes through http URLs", () => {
    expect(resolveA2aTarget("http://robot:8001/", [])).toBe("http://robot:8001");
  });

  it("resolves configured peer names", () => {
    expect(
      resolveA2aTarget("pipeline-robot", [{ name: "pipeline-robot", url: "http://pipeline:8001" }]),
    ).toBe("http://pipeline:8001");
  });

  it("throws for unknown peer names", () => {
    expect(() => resolveA2aTarget("missing", [])).toThrow(/Unknown A2A peer/);
  });
});
