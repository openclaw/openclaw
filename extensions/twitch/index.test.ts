import { describe, expect, it } from "vitest";
import { assertBundledChannelEntries } from "../../test/helpers/bundled-channel-entry.ts";
import entry from "./index.js";
import setupEntry from "./setup-entry.js";

describe("twitch bundled entries", () => {
  assertBundledChannelEntries({
    entry,
    expectedId: "twitch",
    expectedName: "Twitch",
    setupEntry,
  });

  it("loads the setup-only channel plugin", () => {
    const plugin = setupEntry.loadSetupPlugin?.();

    expect(plugin?.id).toBe("twitch");
    expect(plugin?.setupWizard).toBeDefined();
  });
});
