import { describe, expect, it } from "vitest";
import setupEntry from "./setup-entry.js";

describe("qqbot setup entry", () => {
  it("exposes credential backup state migration through setup entry metadata", () => {
    expect(setupEntry.kind).toBe("bundled-channel-setup-entry");
    expect(setupEntry.features).toEqual({ legacyStateMigrations: true });
    expect(setupEntry.loadLegacyStateMigrationDetector?.()).toBeTypeOf("function");
  });
});
