import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLAWORKS_STANDARD_GATEWAY_PORT,
  OPENCLAW_RESERVED_GATEWAY_PORT,
  hasPackSourcesAvailable,
  repairClaworksJsonConfig,
  repairClaworksRobotPluginConfig,
  repairVectorKnowledgeBase,
  seedPacksToStateDir,
  seedRobotMdFromExample,
} from "./product-config-repair.js";

describe("product-config-repair", () => {
  it("repairs gateway port and enables claworks-robot plugin", () => {
    const config: Record<string, unknown> = {
      gateway: { port: OPENCLAW_RESERVED_GATEWAY_PORT },
      plugins: { allow: ["feishu"], entries: {} },
    };
    const result = repairClaworksJsonConfig(config, { seedRobotMd: false });
    expect(result.changed).toBe(true);
    expect((config.gateway as { port: number }).port).toBe(CLAWORKS_STANDARD_GATEWAY_PORT);
    const allow = (config.plugins as { allow: string[] }).allow;
    expect(allow).toContain("claworks-robot");
    const entry = (config.plugins as { entries: Record<string, { enabled?: boolean }> }).entries[
      "claworks-robot"
    ];
    expect(entry?.enabled).toBe(true);
  });

  it("repairVectorKnowledgeBase wires memory slot and lancedb", () => {
    const config: Record<string, unknown> = {
      plugins: { allow: ["claworks-robot"], entries: { "claworks-robot": { enabled: true } } },
    };
    const result = repairVectorKnowledgeBase(config);
    expect(result.changed).toBe(true);
    const plugins = config.plugins as {
      allow: string[];
      slots: { memory: string };
      entries: Record<string, { config?: { data?: { kb_provider?: string } } }>;
    };
    expect(plugins.allow).toContain("memory-lancedb");
    expect(plugins.slots.memory).toBe("memory-lancedb");
    expect(plugins.entries["claworks-robot"].config?.data?.kb_provider).toBe("memory-core");
    const lance = plugins.entries["memory-lancedb"] as {
      config?: { embedding?: { model?: string } };
    };
    expect(lance?.config?.embedding?.model).toBe("text-embedding-3-small");
  });

  it("sets kb_provider when memory-core is allowed", () => {
    const config: Record<string, unknown> = {
      plugins: {
        allow: ["memory-core", "claworks-robot"],
        entries: { "claworks-robot": { enabled: true, config: { data: {} } } },
      },
    };
    repairClaworksJsonConfig(config, { seedRobotMd: false });
    const data = (
      config.plugins as { entries: Record<string, { config: { data: { kb_provider?: string } } }> }
    ).entries["claworks-robot"].config.data;
    expect(data.kb_provider).toBe("memory-core");
  });

  it("seeds robot.md when example exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-repair-"));
    const example = join(dir, "robot.md");
    writeFileSync(example, "# Robot\n", "utf8");
    const stateDir = join(dir, "state");
    const result = seedRobotMdFromExample({ stateDir, examplePath: example });
    expect(result.seeded).toBe(true);
    expect(existsSync(join(stateDir, "robot.md"))).toBe(true);
    expect(readFileSync(join(stateDir, "robot.md"), "utf8")).toContain("Robot");
  });

  it("seedPacksToStateDir links personal-enterprise from claworks-packs", () => {
    const packsDir = join(process.cwd(), "..", "claworks-packs");
    if (!existsSync(join(packsDir, "personal-enterprise", "claworks.pack.json"))) {
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "cw-packs-"));
    const stateDir = join(dir, "state");
    const seed = seedPacksToStateDir({
      stateDir,
      sourceDir: packsDir,
      packIds: ["personal-enterprise"],
    });
    expect(seed.linked).toContain("personal-enterprise");
    expect(seed.missing).not.toContain("personal-enterprise");
  });

  it("hasPackSourcesAvailable is true when claworks-packs exists as sibling", () => {
    const packsDir = join(process.cwd(), "..", "claworks-packs");
    if (existsSync(join(packsDir, "base", "claworks.pack.json"))) {
      expect(hasPackSourcesAvailable({ cwd: process.cwd() })).toBe(true);
    }
  });

  it("repairClaworksRobotPluginConfig adds default packs", () => {
    const config: Record<string, unknown> = { plugins: { entries: {} } };
    const result = repairClaworksRobotPluginConfig(config, { enableEchoConnector: true });
    expect(result.changed).toBe(true);
    const installed = (
      config.plugins as {
        entries: Record<string, { config: { packs: { installed: string[] } } }>;
      }
    ).entries["claworks-robot"].config.packs.installed;
    expect(installed).toContain("base");
    expect(installed).toContain("process-industry");
  });
});
