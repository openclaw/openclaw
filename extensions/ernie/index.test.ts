import { describe, expect, it } from "vitest";
import { registerSingleProviderPlugin } from "../../src/test-utils/plugin-registration.js";
import erniePlugin from "./index.js";

describe("ernie provider plugin", () => {
  it("registers the ernie provider", () => {
    const provider = registerSingleProviderPlugin(erniePlugin);
    expect(provider.id).toBe("ernie");
  });
});
