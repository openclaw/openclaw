import { describe, expect, it } from "vitest";
import entry from "./index.js";
import setupEntry from "./setup-entry.js";

describe("eclaw bundled entries", () => {
  it("defines a channel entry for the eclaw id", () => {
    expect(entry.id).toBe("eclaw");
    expect(entry.name).toBe("E-Claw");
  });

  it("loads the channel plugin without importing the broad api barrel", () => {
    const plugin = entry.loadChannelPlugin();
    expect(plugin.id).toBe("eclaw");
    expect(plugin.meta?.label).toBe("E-Claw");
  });

  it("loads the setup plugin without importing the broad api barrel", () => {
    const plugin = setupEntry.loadSetupPlugin();
    expect(plugin.id).toBe("eclaw");
    expect(plugin.meta?.label).toBe("E-Claw");
  });
});
