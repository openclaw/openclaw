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
    expect(resolved.ot.env?.CLAWORKS_MQTT_SIMULATE).toBe("1");
  });
});
