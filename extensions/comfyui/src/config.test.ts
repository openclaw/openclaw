import path from "node:path";
import { describe, expect, it } from "vitest";
import { isPathUnderRoots, resolveComfyPluginConfig } from "./config.js";

describe("resolveComfyPluginConfig", () => {
  it("returns defaults when config is undefined", () => {
    const config = resolveComfyPluginConfig(undefined);
    expect(config.bridgeUrl).toBe("http://127.0.0.1:8787");
    expect(config.timeoutMs).toBe(180_000);
    expect(config.maxControls).toBe(4);
  });

  it("resolves configured paths to absolute paths", () => {
    const config = resolveComfyPluginConfig({
      outputDir: "./output",
      allowedPathRoots: ["./assets", "/tmp"],
    });
    expect(path.isAbsolute(config.outputDir ?? "")).toBe(true);
    expect(config.allowedPathRoots.every((entry) => path.isAbsolute(entry))).toBe(true);
  });

  it("throws on invalid numeric range", () => {
    expect(() => resolveComfyPluginConfig({ maxWidth: 20 })).toThrow(/maxWidth/);
  });
});

describe("isPathUnderRoots", () => {
  it("returns true for exact root or descendants", () => {
    const root = path.resolve("/tmp/openclaw");
    expect(isPathUnderRoots(root, [root])).toBe(true);
    expect(isPathUnderRoots(path.join(root, "images/out.png"), [root])).toBe(true);
  });

  it("returns false for siblings outside root", () => {
    const root = path.resolve("/tmp/openclaw");
    expect(isPathUnderRoots(path.resolve("/tmp/openclaw2/out.png"), [root])).toBe(false);
  });
});
