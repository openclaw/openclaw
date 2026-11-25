import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

describe("Google Meet transcript source registration", () => {
  it("registers the canonical provider and aliases", () => {
    const { api, transcriptSourceProviders: providers } = createCapturedPluginRegistration();

    plugin.register(api);

    expect(providers).toEqual([
      expect.objectContaining({
        id: "google-meet",
        aliases: ["googlemeet", "meet"],
        sourceKinds: ["live-caption"],
      }),
    ]);
  });
});
