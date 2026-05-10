import { describe, expect, it } from "vitest";
import { resolveThinkingProfile } from "./provider-policy-api.js";

describe("kimi provider-policy-api", () => {
  it("advertises Kimi as binary thinking outside the runtime plugin registry", () => {
    expect(resolveThinkingProfile()).toEqual({
      levels: [
        { id: "off", label: "off" },
        { id: "low", label: "on" },
      ],
      defaultLevel: "off",
    });
  });
});
