import { describe, expect, it } from "vitest";
import { createManagerIndexFixture } from "./manager-index.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("memory manager status model", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });

  it("reports the configured local model path before provider initialization", async () => {
    const manager = await fixture.getFreshManager(
      fixture.createConfig({
        provider: "local",
        model: "adapter-default.gguf",
        local: { modelPath: "/models/custom-embed.gguf" },
      }),
      "status",
    );
    try {
      expect(manager.status()).toMatchObject({
        provider: "local",
        model: "/models/custom-embed.gguf",
      });
    } finally {
      await manager.close?.();
    }
  });
});
