/** Tests internal model discovery imports avoid public SDK facade coupling. */
import { describe, expect, it } from "vitest";

describe("agent-model-discovery internal runtime", () => {
  it("loads without the public agent-sessions SDK facade", async () => {
    const module = await import("./agent-model-discovery.js");
    expect(typeof module.discoverAuthStorage).toBe("function");
    expect(typeof module.discoverModels).toBe("function");
<<<<<<< HEAD
=======
    expect(typeof module.AuthStorage.inMemory).toBe("function");
    expect(typeof module.ModelRegistry.create).toBe("function");
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  });
});
