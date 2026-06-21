import { describe, expect, it } from "vitest";
import { toPublicProfileDriver } from "./profile-driver-display.js";

describe("toPublicProfileDriver", () => {
  it("surfaces the internal resolved 'extension' driver as 'extension-bridge'", () => {
    // resolved "extension" only originates from a configured "extension-bridge"
    // profile (legacy "extension" is doctor-migrated to "existing-session" first),
    // so the public status consistently shows the configured driver name.
    expect(toPublicProfileDriver("extension")).toBe("extension-bridge");
  });
  it("passes openclaw and existing-session through unchanged", () => {
    expect(toPublicProfileDriver("openclaw")).toBe("openclaw");
    expect(toPublicProfileDriver("existing-session")).toBe("existing-session");
  });
});
