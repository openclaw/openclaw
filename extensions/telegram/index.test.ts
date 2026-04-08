import { beforeEach, describe, expect, it, vi } from "vitest";
import entry from "./index.js";
import setupEntry from "./setup-entry.js";

describe("telegram bundled entries", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("declares the channel entry without importing the broad api barrel", () => {
    expect(entry.id).toBe("telegram");
    expect(entry.name).toBe("Telegram");
  });

  it("declares the setup plugin without importing the broad api barrel", () => {
    expect(setupEntry.kind).toBe("bundled-channel-setup-entry");
    expect(typeof setupEntry.loadSetupPlugin).toBe("function");
  });
});
