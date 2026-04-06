import { describe, expect, it } from "vitest";
import entry from "./index.js";
import setupEntry from "./setup-entry.js";

describe("whatsapp bundled entries", () => {
  it("loads the channel plugin without importing the broad api barrel", () => {
    const plugin = entry.loadChannelPlugin();
    expect(plugin.id).toBe("whatsapp");
  });

  it("loads the setup plugin without importing the broad api barrel", () => {
    const plugin = setupEntry.loadSetupPlugin();
    expect(plugin.id).toBe("whatsapp");
  });
});
