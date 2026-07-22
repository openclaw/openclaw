import { describe, expect, it } from "vitest";
import { resolveTenkiPluginConfig } from "./config.js";

describe("resolveTenkiPluginConfig", () => {
  it("applies defaults when config is absent", () => {
    const cfg = resolveTenkiPluginConfig(undefined);
    expect(cfg.workspaceRoot).toBe("/tmp/openclaw-sandboxes");
    expect(cfg.tags).toEqual([]);
    expect(cfg.authToken).toBeUndefined();
    expect(cfg.image).toBeUndefined();
  });

  it("resolves provided values", () => {
    const cfg = resolveTenkiPluginConfig({
      image: "ubuntu-24",
      memoryMb: 4096,
      workspaceRoot: "/srv/openclaw/",
      tags: ["team-a"],
    });
    expect(cfg.image).toBe("ubuntu-24");
    expect(cfg.memoryMb).toBe(4096);
    expect(cfg.workspaceRoot).toBe("/srv/openclaw");
    expect(cfg.tags).toEqual(["team-a"]);
  });

  it("rejects a relative workspace root", () => {
    expect(() => resolveTenkiPluginConfig({ workspaceRoot: "relative/root" })).toThrow(
      /absolute POSIX path/,
    );
  });

  it("rejects unknown keys", () => {
    expect(() => resolveTenkiPluginConfig({ nope: true })).toThrow(/Invalid tenki plugin config/);
  });

  it("rejects non-positive resource values", () => {
    expect(() => resolveTenkiPluginConfig({ cpuCores: 0 })).toThrow(/cpuCores/);
  });
});
