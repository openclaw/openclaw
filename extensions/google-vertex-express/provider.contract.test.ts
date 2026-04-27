import { describe, it } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import plugin from "./index.js";

describe("google-vertex-express provider boundary", () => {
  it("registers as a single provider plugin", async () => {
    // This signal satisfies the provider-family plugin-boundary inventory check.
    await registerSingleProviderPlugin(plugin);
  });
});
