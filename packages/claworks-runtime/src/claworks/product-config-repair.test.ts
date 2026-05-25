import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLAWORKS_STANDARD_GATEWAY_PORT,
  OPENCLAW_RESERVED_GATEWAY_PORT,
  auditConnectorPresets,
  detectPackLayerSystemConflict,
  hasPackSourcesAvailable,
  repairClaworksJsonConfig,
  repairClaworksRobotPluginConfig,
  repairInvalidConnectorPresets,
  repairOtConnectorSimulateFlags,
  repairProductPluginsAllow,
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
    expect(installed).toContain("enterprise-foundation");
    expect(installed).toContain("process-industry");
  });

  it("repairProductPluginsAllow merges extended allow list", () => {
    const config: Record<string, unknown> = { plugins: { allow: ["claworks-robot"], entries: {} } };
    const result = repairProductPluginsAllow(config, { profile: "extended" });
    expect(result.changed).toBe(true);
    const allow = (config.plugins as { allow: string[] }).allow;
    expect(allow).toContain("feishu");
    expect(allow).toContain("memory-lancedb");
  });

  it("detectPackLayerSystemConflict flags core+base", () => {
    const r = detectPackLayerSystemConflict(["core", "base", "comms"]);
    expect(r.conflict).toBe(true);
    expect(r.message).toContain("core");
  });

  it("detectPackLayerSystemConflict ok for new chain only", () => {
    const r = detectPackLayerSystemConflict(["base", "enterprise-foundation"]);
    expect(r.conflict).toBe(false);
    expect(r.message).toBeNull();
  });

  it("repairClaworksRobotPluginConfig warns on mixed layer systems", () => {
    const config: Record<string, unknown> = {
      plugins: {
        entries: {
          "claworks-robot": {
            enabled: true,
            config: { packs: { installed: ["core", "base"] } },
          },
        },
      },
    };
    const result = repairClaworksRobotPluginConfig(config, { enableEchoConnector: false });
    expect(result.warnings.some((w) => w.includes("core") && w.includes("base"))).toBe(true);
  });

  it("repairNotifyTargets derives from feishu allowFrom", () => {
    const config: Record<string, unknown> = {
      channels: { feishu: { allowFrom: ["ou_test"] } },
      plugins: { entries: {} },
    };
    const result = repairClaworksRobotPluginConfig(config, { enableEchoConnector: false });
    expect(result.changed).toBe(true);
    const notify = (
      config.plugins as {
        entries: Record<string, { config: { notify: { targets: Array<{ to: string }> } } }>;
      }
    ).entries["claworks-robot"].config.notify;
    expect(notify.targets[0]?.to).toBe("ou_test");
  });

  it("repairOtConnectorSimulateFlags strips simulate presets in production", () => {
    const connectors = {
      plant: { preset: "mqtt-simulate", simulate: true, enabled: true },
      line: { preset: "mqtt", simulate: true, enabled: true },
    };
    const result = repairOtConnectorSimulateFlags(connectors, { productionMode: true });
    expect(result.changed).toBe(true);
    expect(result.connectors.plant.preset).toBe("mqtt");
    expect(result.connectors.plant.simulate).toBe(false);
    expect(result.connectors.line.simulate).toBe(false);
  });

  it("repairClaworksRobotPluginConfig disables echo connector in production", () => {
    const config: Record<string, unknown> = {
      plugins: {
        entries: {
          "claworks-robot": {
            enabled: true,
            config: {
              production_mode: true,
              connectors: { echo: { preset: "echo", enabled: true } },
            },
          },
        },
      },
    };
    const result = repairClaworksRobotPluginConfig(config, { enableEchoConnector: true });
    expect(result.changed).toBe(true);
    const echo = (
      config.plugins as {
        entries: Record<string, { config: { connectors: { echo: { enabled?: boolean } } } }>;
      }
    ).entries["claworks-robot"].config.connectors.echo;
    expect(echo.enabled).toBe(false);
  });

  it("repairClaworksRobotPluginConfig does not add echo in production", () => {
    const config: Record<string, unknown> = {
      plugins: {
        entries: {
          "claworks-robot": {
            enabled: true,
            config: { production_mode: true, connectors: {} },
          },
        },
      },
    };
    repairClaworksRobotPluginConfig(config, { enableEchoConnector: true });
    const connectors = (
      config.plugins as { entries: Record<string, { config: { connectors?: { echo?: unknown } } }> }
    ).entries["claworks-robot"].config.connectors;
    expect(connectors?.echo).toBeUndefined();
  });

  it("repairOtConnectorSimulateFlags honors CLAWORKS_PRODUCTION env", () => {
    const connectors = {
      plant: { preset: "opcua-simulate", simulate: true, enabled: true },
    };
    const result = repairOtConnectorSimulateFlags(connectors, {
      env: { CLAWORKS_PRODUCTION: "1" },
    });
    expect(result.changed).toBe(true);
    expect(result.connectors.plant.preset).toBe("opcua");
    expect(result.connectors.plant.simulate).toBe(false);
  });

  it("auditConnectorPresets flags unknown presets", () => {
    const audit = auditConnectorPresets({
      kb: { preset: "filesystem-kb", enabled: true },
      bad: { preset: "not-a-preset", enabled: true },
    });
    expect(audit.invalid).toEqual([{ id: "bad", preset: "not-a-preset" }]);
    expect(audit.simulatePresets).toEqual([]);
  });

  it("repairInvalidConnectorPresets normalizes filesystem_kb typo", () => {
    const connectors = {
      kb: { preset: "filesystem_kb", enabled: true },
    };
    const result = repairInvalidConnectorPresets(connectors);
    expect(result.changed).toBe(true);
    expect(result.connectors.kb.preset).toBe("filesystem-kb");
  });
});
