import { describe, expect, it } from "vitest";
import entry from "./index.js";
import setupEntry from "./setup-entry.js";

describe("irc bundled entries", () => {
  it("loads the channel plugin without importing the broad api barrel", () => {
    const plugin = entry.loadChannelPlugin();
    expect(plugin.id).toBe("irc");
  });

  it("loads the setup plugin without importing the broad api barrel", () => {
    const plugin = setupEntry.loadSetupPlugin();
    expect(plugin.id).toBe("irc");
  });
});
