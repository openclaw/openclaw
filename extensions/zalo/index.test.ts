import { describe, expect, it } from "vitest";
import entry from "./index.js";
import setupEntry from "./setup-entry.js";

describe("zalo bundled entries", () => {
  it("loads the channel plugin without a runtime-barrel cycle", () => {
    const plugin = entry.loadChannelPlugin();
    expect(plugin.id).toBe("zalo");
  });

  it("loads the setup plugin without a runtime-barrel cycle", () => {
    const plugin = setupEntry.loadSetupPlugin();
    expect(plugin.id).toBe("zalo");
  });
});
