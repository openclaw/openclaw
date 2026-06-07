import { describe, expect, it } from "vitest";
import {
  assertSupportedBridgeVersion,
  ClaudeAppServerVersionError,
  resolveBridgeSpawnEnv,
} from "./client.js";
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

describe("resolveBridgeSpawnEnv", () => {
  it("forwards safe host env and config overrides to the spawned bridge", () => {
    const env = resolveBridgeSpawnEnv(
      { PATH: "/usr/bin", HOME: "/home/agent", SAFE: "1" },
      { MY_VAR: "ok" },
    );
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/agent");
    expect(env.SAFE).toBe("1");
    expect(env.MY_VAR).toBe("ok");
  });

  it("rejects config-derived overrides that try to inject dangerous exec env (GHSA-VFW7-6RHC-6XXG)", () => {
    // `appServer.env` is workspace-config-derived. A config that sets
    // NODE_OPTIONS / LD_PRELOAD would otherwise be merged straight into the
    // child's env and achieve code execution. The canonical sanitizer rejects
    // those override keys instead of letting them through.
    const env = resolveBridgeSpawnEnv(
      { PATH: "/usr/bin", HOME: "/home/agent" },
      {
        NODE_OPTIONS: "--require /tmp/evil.js",
        LD_PRELOAD: "/tmp/evil.so",
        DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib",
      },
    );
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.LD_PRELOAD).toBeUndefined();
    expect(env.DYLD_INSERT_LIBRARIES).toBeUndefined();
  });

  it("never lets a config override replace PATH (command-resolution boundary)", () => {
    const env = resolveBridgeSpawnEnv({ PATH: "/usr/bin" }, { PATH: "/attacker/bin" });
    expect(env.PATH).toBe("/usr/bin");
  });

  it("drops undefined override values before sanitizing", () => {
    const env = resolveBridgeSpawnEnv({ PATH: "/usr/bin" }, { UNSET: undefined, KEEP: "v" });
    expect(env.KEEP).toBe("v");
    expect(Object.hasOwn(env, "UNSET")).toBe(false);
  });
});
