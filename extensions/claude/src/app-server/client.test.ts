import { describe, expect, it } from "vitest";
import { assertSupportedBridgeVersion, ClaudeAppServerVersionError } from "./client.js";
import { MANAGED_CLAUDE_BRIDGE_PACKAGE, MIN_CLAUDE_BRIDGE_VERSION } from "./version.js";

describe("assertSupportedBridgeVersion", () => {
  it("passes at or above the floor", () => {
    expect(() => assertSupportedBridgeVersion(MIN_CLAUDE_BRIDGE_VERSION, "managed")).not.toThrow();
    expect(() => assertSupportedBridgeVersion("99.0.0", "managed")).not.toThrow();
  });

  it("throws a reinstall-oriented message below the floor for the managed binary", () => {
    let err: unknown;
    try {
      assertSupportedBridgeVersion("0.2.10", "managed");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ClaudeAppServerVersionError);
    const message = (err as Error).message;
    expect(message).toContain("0.2.10");
    expect(message).toContain(MIN_CLAUDE_BRIDGE_VERSION);
    expect(message).toContain(MANAGED_CLAUDE_BRIDGE_PACKAGE);
    expect(message.toLowerCase()).toContain("reinstall");
  });

  it("points an explicit override at appServer.command / the env var", () => {
    for (const source of ["config", "env"] as const) {
      let err: unknown;
      try {
        assertSupportedBridgeVersion("0.2.10", source);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ClaudeAppServerVersionError);
      expect((err as Error).message).toContain("appServer.command");
    }
  });

  it("treats an unknown running version as too old", () => {
    expect(() => assertSupportedBridgeVersion(undefined, "managed")).toThrow(
      ClaudeAppServerVersionError,
    );
  });
});
