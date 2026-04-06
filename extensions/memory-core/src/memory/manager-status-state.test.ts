import { describe, expect, it } from "vitest";
import { resolveInitialMemoryDirty, resolveStatusProviderInfo } from "./manager-status-state.js";

describe("memory manager status state", () => {
  it("keeps memory clean for status-only managers after prior indexing", () => {
    expect(
      resolveInitialMemoryDirty({
        hasMemorySource: true,
        statusOnly: true,
        hasIndexedMeta: true,
      }),
    ).toBe(false);
  });

  it("marks status-only managers dirty when no prior index metadata exists", () => {
    expect(
      resolveInitialMemoryDirty({
        hasMemorySource: true,
        statusOnly: true,
        hasIndexedMeta: false,
      }),
    ).toBe(true);
  });

  it("reports the requested provider before provider initialization", () => {
    expect(
      resolveStatusProviderInfo({
        provider: null,
        providerInitialized: false,
        requestedProvider: "openai",
        configuredModel: "mock-embed",
      }),
    ).toEqual({
      provider: "openai",
      model: "mock-embed",
      searchMode: "hybrid",
    });
  });

  it("reports fts-only mode when initialization finished without a provider", () => {
    expect(
      resolveStatusProviderInfo({
        provider: null,
        providerInitialized: true,
        requestedProvider: "openai",
        configuredModel: "mock-embed",
      }),
    ).toEqual({
      provider: "none",
      model: undefined,
      searchMode: "fts-only",
    });
  });
});
