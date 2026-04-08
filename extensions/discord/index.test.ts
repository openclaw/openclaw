import { describe, expect, it } from "vitest";
import entry from "./index.js";
import setupEntry from "./setup-entry.js";

describe("discord bundled entries", () => {
  it("declares the channel plugin without importing the broad api barrel", () => {
    expect(entry.kind).toBe("bundled-channel-entry");
    expect(entry.id).toBe("discord");
    expect(entry.name).toBe("Discord");
  });

  it("declares the setup plugin without importing the broad api barrel", () => {
    expect(setupEntry.kind).toBe("bundled-channel-setup-entry");
    expect(typeof setupEntry.loadSetupPlugin).toBe("function");
  });
});
