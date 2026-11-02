import { describe, expect, it } from "vitest";
import { resolveAnthropicVertexRegion } from "./api.js";

describe("anthropic vertex region helpers", () => {
  it("falls back to the default region for malformed env values", () => {
    expect(
      resolveAnthropicVertexRegion({ GOOGLE_CLOUD_LOCATION: "us-central1.attacker.example" }),
    ).toBe("global");
  });
});
