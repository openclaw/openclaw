import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");

const pluginManifest = JSON.parse(
  fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
) as Record<string, unknown>;

const openclawManifest = JSON.parse(
  fs.readFileSync(path.join(ROOT, "openclaw.plugin.json"), "utf8"),
) as Record<string, unknown>;

describe("ClaWorks Robot Plugin", () => {
  it("package.json 包含必要字段", () => {
    expect(pluginManifest.name).toMatch(/claworks/);
    expect(pluginManifest.version).toBeDefined();
    expect(pluginManifest.description).toBeDefined();
  });

  it("openclaw.plugin.json 包含 manifest 必要字段", () => {
    expect(openclawManifest.id).toBe("claworks-robot");
    expect(openclawManifest.name).toBeDefined();
    expect(openclawManifest.version).toBeDefined();
    expect(openclawManifest.description).toBeDefined();
  });

  it("openclaw.plugin.json 声明 services 和 tools", () => {
    expect(Array.isArray(openclawManifest.provides)).toBe(true);
    expect(openclawManifest.provides).toContain("service");
    expect(openclawManifest.provides).toContain("tools");
  });

  it("contracts.tools 列表非空且全部以 cw_ 前缀开头", () => {
    const contracts = openclawManifest.contracts as { tools?: string[] };
    expect(Array.isArray(contracts?.tools)).toBe(true);
    expect(contracts.tools!.length).toBeGreaterThan(0);
    for (const tool of contracts.tools!) {
      expect(tool.startsWith("cw_")).toBe(true);
    }
  });

  it("插件入口文件存在", () => {
    expect(fs.existsSync(path.join(ROOT, "index.ts"))).toBe(true);
  });

  it("cw-tools.ts 和 cw-tools-ops.ts 存在", () => {
    expect(fs.existsSync(path.join(ROOT, "cw-tools.ts"))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, "cw-tools-ops.ts"))).toBe(true);
  });

  it("openclaw.plugin.json 的 services 包含 claworks-kernel", () => {
    const services = openclawManifest.services as Array<{ id?: string }>;
    expect(Array.isArray(services)).toBe(true);
    expect(services.some((s) => s.id === "claworks-kernel")).toBe(true);
  });

  it("activation.onStartup 为 true", () => {
    const activation = openclawManifest.activation as { onStartup?: boolean };
    expect(activation?.onStartup).toBe(true);
  });
});
