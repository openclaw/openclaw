import { MAX_TIMER_TIMEOUT_SECONDS } from "openclaw/plugin-sdk/number-runtime";
import { describe, expect, test } from "vitest";
import { createMxcPluginConfigSchema, resolveConfig } from "../src/config.js";

describe("resolveConfig", () => {
  test("uses defaults only when config is omitted", () => {
    expect(resolveConfig(undefined)).toEqual({
      mxcBinaryPath: undefined,
      containment: "process",
      network: "none",
      timeoutSeconds: 120,
      debug: false,
    });

    const config = resolveConfig({});
    expect(config).toEqual({
      mxcBinaryPath: undefined,
      containment: "process",
      network: "none",
      timeoutSeconds: 120,
      debug: false,
      mxcPolicyPaths: undefined,
    });
    expect(config).not.toHaveProperty("timeoutSecondsConfigured");
  });

  test("applies valid overrides and preserves explicit timeout configuration", () => {
    const config = resolveConfig({
      mxcBinaryPath: "  C:\\custom\\wxc-exec.exe  ",
      containment: "processcontainer",
      network: "default",
      timeoutSeconds: 60,
      debug: true,
      mxcPolicyPaths: [
        "  C:\\ProgramData\\openclaw\\mxc-machine-policy.json  ",
        "  /opt/openclaw/mxc-user-policy.json  ",
      ],
    });

    expect(config).toEqual({
      mxcBinaryPath: "C:\\custom\\wxc-exec.exe",
      containment: "processcontainer",
      network: "default",
      timeoutSeconds: 60,
      timeoutSecondsConfigured: true,
      debug: true,
      mxcPolicyPaths: [
        "C:\\ProgramData\\openclaw\\mxc-machine-policy.json",
        "/opt/openclaw/mxc-user-policy.json",
      ],
    });
  });

  test("trims and validates mxcPolicyPaths as absolute paths", () => {
    expect(() => resolveConfig({ mxcPolicyPaths: "C:\\policy.json" })).toThrow(/mxcPolicyPaths/u);
    expect(() => resolveConfig({ mxcPolicyPaths: ["relative-policy.json"] })).toThrow(
      /mxcPolicyPaths\[0\]/u,
    );
    expect(() => resolveConfig({ mxcPolicyPaths: ["   "] })).toThrow(/mxcPolicyPaths/u);
    expect(() => resolveConfig({ mxcPolicyPaths: [42] })).toThrow(/mxcPolicyPaths/u);
  });
});

describe("createMxcPluginConfigSchema", () => {
  test("publishes the same timeout cap in the plugin schema", () => {
    const jsonSchema = createMxcPluginConfigSchema().jsonSchema as {
      properties?: { timeoutSeconds?: unknown };
    };
    expect(jsonSchema.properties?.timeoutSeconds).toEqual({
      type: "number",
      minimum: 1,
      maximum: MAX_TIMER_TIMEOUT_SECONDS,
      description:
        "Per-command execution timeout in seconds. Capped to the sandbox policy baseline timeout when both are set.",
    });
  });
});
