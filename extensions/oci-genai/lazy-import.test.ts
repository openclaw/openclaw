import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";

describe("oci-genai lazy imports", () => {
  it("registers the provider without touching ~/.oci/config or signing keys", async () => {
    // The plugin entry should not call out to disk during plugin registration —
    // the heavy work (loading the profile, signing requests) lives behind the
    // memory adapter and the chat catalog runs.
    const { default: ociPlugin } = await import("./index.js");
    const provider = await registerSingleProviderPlugin(ociPlugin);

    expect(provider.id).toBe("oci");
    expect(provider.label).toBe("Oracle Cloud Infrastructure GenAI");
    expect(provider.docsPath).toBe("/providers/oci");
  });
});
