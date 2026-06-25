import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveMxcPluginRoot, resolveMxcLauncherPath } from "../src/plugin-root.js";

describe("resolveMxcPluginRoot", () => {
  it("returns the plugin root when called from inside the plugin", () => {
    const root = resolveMxcPluginRoot();
    expect(fs.existsSync(path.join(root, "openclaw.plugin.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, "package.json"))).toBe(true);
    expect(path.basename(root)).toBe("mxc");
  });

  it("throws when called from outside any plugin tree", () => {
    const outside = pathToFileURL(path.resolve("README.md")).href;
    expect(() => resolveMxcPluginRoot(outside)).toThrow(/cannot locate plugin root/);
  });
});

describe("resolveMxcLauncherPath", () => {
  it("returns the src .mjs in dev layout", () => {
    const launcher = resolveMxcLauncherPath();
    expect(launcher).toMatch(/mxc-spawn-launcher\.mjs$/);
    expect(fs.existsSync(launcher)).toBe(true);
  });
});
