import { describe, expect, it } from "vitest";
import entry from "./index.js";
import setupEntry from "./setup-entry.js";

describe("zalo bundled entries", () => {
  it("declares the channel plugin without a runtime-barrel cycle", () => {
    expect(entry.kind).toBe("bundled-channel-entry");
    expect(entry.id).toBe("zalo");
    expect(entry.name).toBe("Zalo");
  });

  it("declares the setup plugin without a runtime-barrel cycle", () => {
    expect(setupEntry.kind).toBe("bundled-channel-setup-entry");
    expect(typeof setupEntry.loadSetupPlugin).toBe("function");
  });
});
