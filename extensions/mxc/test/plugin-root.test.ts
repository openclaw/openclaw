import fs, { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { resolveMxcLauncherPath } from "../src/plugin-root.js";

describe("resolveMxcLauncherPath", () => {
  it("throws when called from outside any plugin tree", () => {
    const outside = pathToFileURL(path.resolve("README.md")).href;
    expect(() => resolveMxcLauncherPath(outside)).toThrow(/cannot locate plugin root/);
  });

  it("returns the src .mjs in dev layout", () => {
    const launcher = resolveMxcLauncherPath();
    expect(launcher).toMatch(/mxc-spawn-launcher\.mjs$/);
    expect(fs.existsSync(launcher)).toBe(true);
  });

  it("returns the package dist launcher in packed plugin layout", () => {
    const root = mkdtempSync(path.join(tmpdir(), "mxc-packed-plugin-"));
    try {
      writeFileSync(path.join(root, "package.json"), "{}");
      writeFileSync(path.join(root, "openclaw.plugin.json"), "{}");
      const distDir = path.join(root, "dist");
      fs.mkdirSync(distDir, { recursive: true });
      const launcher = path.join(distDir, "mxc-spawn-launcher.mjs");
      writeFileSync(launcher, "export {};\n");
      const moduleUrl = pathToFileURL(path.join(distDir, "index.js")).href;

      expect(resolveMxcLauncherPath(moduleUrl)).toBe(launcher);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns the copied root launcher in a bundled plugin layout", () => {
    const root = mkdtempSync(path.join(tmpdir(), "mxc-bundled-plugin-"));
    try {
      writeFileSync(path.join(root, "package.json"), "{}");
      writeFileSync(path.join(root, "openclaw.plugin.json"), "{}");
      const launcher = path.join(root, "mxc-spawn-launcher.mjs");
      writeFileSync(launcher, "export {};\n");
      expect(resolveMxcLauncherPath(pathToFileURL(path.join(root, "index.js")).href)).toBe(
        launcher,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses a declared embedded launcher when its disk source was pruned", () => {
    const root = mkdtempSync(path.join(tmpdir(), "mxc-embedded-plugin-"));
    try {
      writeFileSync(path.join(root, "package.json"), "{}");
      writeFileSync(path.join(root, "openclaw.plugin.json"), "{}");
      const launcher = path.join(root, "mxc-spawn-launcher.mjs");
      vi.stubGlobal(
        "__openclawStandaloneIsEmbeddedModule",
        (candidate: string) => candidate === launcher,
      );
      expect(resolveMxcLauncherPath(pathToFileURL(path.join(root, "index.js")).href)).toBe(
        launcher,
      );
      expect(fs.existsSync(launcher)).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prefers the embedded launcher to a source file beside the image", () => {
    const root = mkdtempSync(path.join(tmpdir(), "mxc-embedded-source-plugin-"));
    try {
      writeFileSync(path.join(root, "package.json"), "{}");
      writeFileSync(path.join(root, "openclaw.plugin.json"), "{}");
      fs.mkdirSync(path.join(root, "src"));
      writeFileSync(
        path.join(root, "src", "mxc-spawn-launcher.mjs"),
        "throw new Error('disk source');\n",
      );
      const launcher = path.join(root, "mxc-spawn-launcher.mjs");
      vi.stubGlobal(
        "__openclawStandaloneIsEmbeddedModule",
        (candidate: string) => candidate === launcher,
      );
      expect(resolveMxcLauncherPath(pathToFileURL(path.join(root, "index.js")).href)).toBe(
        launcher,
      );
    } finally {
      vi.unstubAllGlobals();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
