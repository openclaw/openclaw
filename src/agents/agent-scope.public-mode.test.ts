import { describe, expect, it } from "vitest";
import { resolveAgentPublicMode } from "./agent-scope.js";

describe("resolveAgentPublicMode", () => {
  it("inherits agents.defaults.publicMode when an agent has no explicit override", () => {
    expect(
      resolveAgentPublicMode(
        {
          agents: {
            defaults: { publicMode: true },
            list: [{ id: "public-agent" }],
          },
        },
        "public-agent",
      ),
    ).toBe(true);
  });

  it("lets an explicit per-agent false override a default true value", () => {
    expect(
      resolveAgentPublicMode(
        {
          agents: {
            defaults: { publicMode: true },
            list: [{ id: "private-agent", publicMode: false }],
          },
        },
        "private-agent",
      ),
    ).toBe(false);
  });
});
