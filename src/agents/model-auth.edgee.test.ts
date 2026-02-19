import { afterEach, describe, expect, it } from "vitest";
import { resolveEnvApiKey } from "./model-auth.js";

describe("resolveEnvApiKey edgee", () => {
  const previous = process.env.EDGEE_API_KEY;

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.EDGEE_API_KEY;
    } else {
      process.env.EDGEE_API_KEY = previous;
    }
  });

  it("resolves EDGEE_API_KEY for edgee provider", () => {
    process.env.EDGEE_API_KEY = "edgee-env-key";
    const resolved = resolveEnvApiKey("edgee");
    expect(resolved).toMatchObject({
      apiKey: "edgee-env-key",
      source: expect.stringContaining("EDGEE_API_KEY"),
    });
  });
});
