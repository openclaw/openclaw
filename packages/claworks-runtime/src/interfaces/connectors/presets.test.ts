import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getConnectorPreset, resolveConnectorConfigs } from "./presets.js";

describe("connector presets", () => {
  const root = join(process.cwd());

  it("resolves echo preset", () => {
    const preset = getConnectorPreset("echo", root);
    expect(preset?.command).toBe(process.execPath);
    expect(preset?.args?.[0]).toContain("echo-bridge.mjs");
  });

  it("resolves preset-only echo input (no explicit command)", () => {
    const resolved = resolveConnectorConfigs({ echo: { preset: "echo", enabled: true } }, root);
    expect(resolved.echo.command).toBe(process.execPath);
    expect(resolved.echo.args?.[0]).toContain("echo-bridge.mjs");
    expect(resolved.echo.enabled).toBe(true);
  });

  it("merges preset with overrides", () => {
    const resolved = resolveConnectorConfigs(
      {
        ot: {
          preset: "mqtt",
          enabled: true,
          env: { CLAWORKS_MQTT_TOPIC: "plant/alarms/#" },
        },
      },
      root,
    );
    expect(resolved.ot.args?.[0]).toContain("mqtt-bridge.mjs");
    expect(resolved.ot.env?.CLAWORKS_MQTT_TOPIC).toBe("plant/alarms/#");
    // mqtt preset（生产路径）不自动设置 SIMULATE，需通过 simulate:true 显式启用
    expect(resolved.ot.env?.CLAWORKS_MQTT_SIMULATE).toBeUndefined();
  });

  it("simulate:true activates simulate preset variant", () => {
    const resolved = resolveConnectorConfigs(
      {
        ot: {
          preset: "mqtt",
          simulate: true,
          enabled: true,
          env: { CLAWORKS_MQTT_TOPIC: "plant/alarms/#" },
        },
      },
      root,
    );
    expect(resolved.ot.args?.[0]).toContain("mqtt-bridge.mjs");
    expect(resolved.ot.env?.CLAWORKS_MQTT_TOPIC).toBe("plant/alarms/#");
    expect(resolved.ot.env?.CLAWORKS_MQTT_SIMULATE).toBe("1");
  });
});
