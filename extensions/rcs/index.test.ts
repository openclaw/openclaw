// Rcs tests cover its bundled channel entry contract.
import { describe, expect, it } from "vitest";
import entry from "./index.js";

describe("rcs bundled entry", () => {
  it("declares the current bundled channel contract", () => {
    expect(entry.kind).toBe("bundled-channel-entry");
    expect(entry.id).toBe("rcs");
    expect(entry.name).toBe("RCS");
    expect(typeof entry.loadChannelPlugin).toBe("function");
    expect(typeof entry.setChannelRuntime).toBe("function");
  });
});
