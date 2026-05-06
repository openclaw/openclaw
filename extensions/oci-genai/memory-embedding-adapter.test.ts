import { describe, expect, it } from "vitest";
import { DEFAULT_OCI_EMBEDDING_MODEL } from "./embedding-provider.js";
import { ociMemoryEmbeddingProviderAdapter } from "./memory-embedding-adapter.js";

describe("ociMemoryEmbeddingProviderAdapter", () => {
  it("declares stable adapter metadata", () => {
    expect(ociMemoryEmbeddingProviderAdapter.id).toBe("oci");
    expect(ociMemoryEmbeddingProviderAdapter.transport).toBe("remote");
    expect(ociMemoryEmbeddingProviderAdapter.authProviderId).toBe("oci");
    expect(ociMemoryEmbeddingProviderAdapter.defaultModel).toBe(DEFAULT_OCI_EMBEDDING_MODEL);
    expect(ociMemoryEmbeddingProviderAdapter.autoSelectPriority).toBe(55);
    expect(ociMemoryEmbeddingProviderAdapter.allowExplicitWhenConfiguredAuto).toBe(true);
  });

  it("surfaces a discoverable error when no OCI config is reachable", async () => {
    // No env, no fixture profile — the adapter should refuse with a clear hint.
    const previous = {
      OCI_PROFILE: process.env.OCI_PROFILE,
      OCI_CONFIG_FILE: process.env.OCI_CONFIG_FILE,
    };
    process.env.OCI_PROFILE = "DOES_NOT_EXIST_PROFILE";
    process.env.OCI_CONFIG_FILE = "/tmp/oci-genai-nonexistent-config";
    try {
      await expect(
        ociMemoryEmbeddingProviderAdapter.create({
          provider: "oci",
          fallback: "none",
          model: DEFAULT_OCI_EMBEDDING_MODEL,
          config: {},
        } as never),
      ).rejects.toThrowError(/No API key found for provider "oci"/);
    } finally {
      if (previous.OCI_PROFILE === undefined) {
        delete process.env.OCI_PROFILE;
      } else {
        process.env.OCI_PROFILE = previous.OCI_PROFILE;
      }
      if (previous.OCI_CONFIG_FILE === undefined) {
        delete process.env.OCI_CONFIG_FILE;
      } else {
        process.env.OCI_CONFIG_FILE = previous.OCI_CONFIG_FILE;
      }
    }
  });
});
