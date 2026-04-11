import { describe, expect, it } from "vitest";
import { buildChromeSpawnEnv } from "./chrome.js";

describe("buildChromeSpawnEnv", () => {
  const HOME = "/home/openclaw-test";

  it("pins HOME to the resolved home on every platform", () => {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      const env = buildChromeSpawnEnv({
        base: { HOME: "/tmp/other-home", PATH: "/usr/bin" },
        platform,
        headless: false,
        home: HOME,
      });
      expect(env.HOME).toBe(HOME);
      expect(env.PATH).toBe("/usr/bin");
    }
  });

  it("injects DISPLAY=:0 on Linux in non-headless mode when unset", () => {
    const env = buildChromeSpawnEnv({
      base: { PATH: "/usr/bin" },
      platform: "linux",
      headless: false,
      home: HOME,
    });
    expect(env.DISPLAY).toBe(":0");
  });

  it("does not override an existing DISPLAY on Linux", () => {
    const env = buildChromeSpawnEnv({
      base: { DISPLAY: ":1", PATH: "/usr/bin" },
      platform: "linux",
      headless: false,
      home: HOME,
    });
    expect(env.DISPLAY).toBe(":1");
  });

  it("does not inject DISPLAY when headless on Linux", () => {
    const env = buildChromeSpawnEnv({
      base: { PATH: "/usr/bin" },
      platform: "linux",
      headless: true,
      home: HOME,
    });
    expect(env.DISPLAY).toBeUndefined();
  });

  it("does not inject DISPLAY on macOS", () => {
    const env = buildChromeSpawnEnv({
      base: { PATH: "/usr/bin" },
      platform: "darwin",
      headless: false,
      home: HOME,
    });
    expect(env.DISPLAY).toBeUndefined();
  });

  it("does not inject DISPLAY on Windows", () => {
    const env = buildChromeSpawnEnv({
      base: { PATH: "C:\\Windows" },
      platform: "win32",
      headless: false,
      home: HOME,
    });
    expect(env.DISPLAY).toBeUndefined();
  });
});
