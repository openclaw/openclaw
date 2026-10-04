import { readFileSync } from "node:fs";
import { buildJsonPluginConfigSchema } from "openclaw/plugin-sdk/core";
import { MAX_TIMER_TIMEOUT_SECONDS } from "openclaw/plugin-sdk/number-runtime";
import { describe, expect, test } from "vitest";
import {
  createMxcPluginConfigSchema,
  resolveConfig,
  resolveMxcAgentConfig,
} from "../src/config.js";

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

  test("rejects invalid root values and unknown keys", () => {
    expect(() => resolveConfig(null)).toThrow(/Invalid mxc plugin config/u);
    expect(() => resolveConfig("bad")).toThrow(/Invalid mxc plugin config/u);
    expect(() => resolveConfig({ sandboxBaseline: {} })).toThrow(/sandboxBaseline/u);
  });

  test("rejects removed and malformed containment values", () => {
    for (const containment of ["windows_sandbox", "invalid"]) {
      expect(() => resolveConfig({ containment })).toThrow(/containment/u);
    }
  });

  test("rejects malformed enums and types instead of silently falling back", () => {
    expect(() => resolveConfig({ network: "allow-all" })).toThrow(/network/u);
    expect(() => resolveConfig({ debug: "true" })).toThrow(/debug/u);
    expect(() => resolveConfig({ mxcBinaryPath: "   " })).toThrow(/mxcBinaryPath/u);
  });

  test("enforces timeout bounds and only marks configured timeouts when supplied", () => {
    expect(() => resolveConfig({ timeoutSeconds: 0 })).toThrow(/>= 1/u);
    expect(() => resolveConfig({ timeoutSeconds: "fast" })).toThrow(/timeoutSeconds/u);
    expect(() => resolveConfig({ timeoutSeconds: MAX_TIMER_TIMEOUT_SECONDS + 1 })).toThrow(
      new RegExp(`${MAX_TIMER_TIMEOUT_SECONDS}`, "u"),
    );

    const config = resolveConfig({ timeoutSeconds: MAX_TIMER_TIMEOUT_SECONDS });
    expect(config.timeoutSeconds).toBe(MAX_TIMER_TIMEOUT_SECONDS);
    expect(config.timeoutSecondsConfigured).toBe(true);
  });

  test("trims and validates mxcPolicyPaths as absolute paths", () => {
    expect(() => resolveConfig({ mxcPolicyPaths: "C:\\policy.json" })).toThrow(/mxcPolicyPaths/u);
    expect(() => resolveConfig({ mxcPolicyPaths: ["relative-policy.json"] })).toThrow(
      /mxcPolicyPaths entries must be absolute paths/u,
    );
    expect(() => resolveConfig({ mxcPolicyPaths: ["   "] })).toThrow(/mxcPolicyPaths/u);
    expect(() => resolveConfig({ mxcPolicyPaths: [42] })).toThrow(/mxcPolicyPaths/u);
  });
});

describe("createMxcPluginConfigSchema", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
  );
  const admission = buildJsonPluginConfigSchema(manifest.configSchema);

  test("keeps the manifest and runtime schema aligned", () => {
    expect(createMxcPluginConfigSchema().jsonSchema).toEqual(manifest.configSchema);
  });

  test.each(
    [
      null,
      [],
      "bad",
      { agents: null },
      { agents: [] },
      { agents: "bad" },
      { agents: { analyst: null } },
      { agents: { analyst: [] } },
      ...[
        "Analyst",
        "bad.id",
        "bad id",
        "",
        "a".repeat(65),
        "__proto__",
        "prototype",
        "constructor",
      ].map((id) => ({
        agents: { [id]: {} },
      })),
      ...["debug", "containment", "mxcBinaryPath", "securityLevel", "unknown"].map((key) => ({
        agents: { analyst: { [key]: true } },
      })),
      ...[null, "allow-all", true].map((network) => ({ agents: { analyst: { network } } })),
      ...[0, -1, MAX_TIMER_TIMEOUT_SECONDS + 1, "10", null].map((timeoutSeconds) => ({
        agents: { analyst: { timeoutSeconds } },
      })),
      ...[null, "C:\\policy.json", ["relative.json"], [""], [42]].map((mxcPolicyPaths) => ({
        agents: { analyst: { mxcPolicyPaths } },
      })),
    ].map((value) => [value] as const),
  )("rejects invalid admission and runtime settings: %j", (value) => {
    expect(admission.safeParse?.(value).success).toBe(false);
    expect(createMxcPluginConfigSchema().safeParse?.(value).success).toBe(false);
    expect(() => resolveConfig(value)).toThrow();
  });

  test.each([
    {},
    { agents: {} },
    { agents: { "a-1_b": {} } },
    { agents: { _worker: {} } },
    {
      agents: {
        ["a".repeat(64)]: {
          network: "default",
          timeoutSeconds: 1.5,
          mxcPolicyPaths: ["  C:\\policy.json  "],
        },
      },
    },
  ])("accepts valid boundary settings at admission and runtime: %j", (value) => {
    expect(admission.safeParse?.(value).success).toBe(true);
    expect(createMxcPluginConfigSchema().safeParse?.(value).success).toBe(true);
  });

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

describe("per-agent policy selection", () => {
  test("accepts underscore-prefixed owners and default inheritance with unrelated overrides", () => {
    const defaults = { network: "default", timeoutSeconds: 60 };
    const inherited = resolveConfig({ ...defaults, agents: { analyst: { network: "none" } } });
    expect(resolveMxcAgentConfig(inherited, "_worker", "agent")).toMatchObject(defaults);
    const overridden = resolveConfig({ ...defaults, agents: { _worker: { network: "none" } } });
    expect(resolveMxcAgentConfig(overridden, "_worker", "agent")).toMatchObject({
      network: "none",
      timeoutSeconds: 60,
    });
  });

  test("inherits absent fields and entries, replaces explicit lists including empty lists", () => {
    const config = resolveConfig({
      network: "default",
      timeoutSeconds: 60,
      mxcPolicyPaths: ["C:\\default.json"],
      agents: {
        analyst: { network: "none", mxcPolicyPaths: [] },
        reviewer: { timeoutSeconds: 5, mxcPolicyPaths: ["C:\\review.json"] },
        inherited: { network: undefined, timeoutSeconds: undefined, mxcPolicyPaths: undefined },
      },
    });
    for (const id of ["other", "inherited"]) {
      expect(resolveMxcAgentConfig(config, id, "agent")).toMatchObject({
        network: "default",
        timeoutSeconds: 60,
        mxcPolicyPaths: ["C:\\default.json"],
      });
    }
    const a = resolveMxcAgentConfig(config, "analyst", "agent");
    const b = resolveMxcAgentConfig(config, "reviewer", "session");
    const aAgain = resolveMxcAgentConfig(config, "analyst", "agent");
    expect(a).toMatchObject({ network: "none", timeoutSeconds: 60, mxcPolicyPaths: [] });
    expect(b).toMatchObject({
      network: "default",
      timeoutSeconds: 5,
      timeoutSecondsConfigured: true,
      mxcPolicyPaths: ["C:\\review.json"],
    });
    expect(aAgain).toEqual(a);
    expect(aAgain).not.toBe(a);
    expect(aAgain.mxcPolicyPaths).not.toBe(a.mxcPolicyPaths);
    b.mxcPolicyPaths?.push("C:\\not-shared.json");
    expect(config.agents?.reviewer?.mxcPolicyPaths).toEqual(["C:\\review.json"]);
  });

  test("marks per-agent timeout explicit, but leaves omitted timeouts baseline-controlled", () => {
    const config = resolveConfig({ agents: { analyst: { timeoutSeconds: 3 }, other: {} } });
    expect(resolveMxcAgentConfig(config, "analyst", "agent").timeoutSecondsConfigured).toBe(true);
    expect(
      resolveMxcAgentConfig(config, "other", "agent").timeoutSecondsConfigured,
    ).toBeUndefined();
  });

  test("fails closed on missing/noncanonical agent context only with a nonempty map", () => {
    for (const value of [undefined, {}, { agents: {} }]) {
      expect(resolveMxcAgentConfig(resolveConfig(value), undefined, "shared").network).toBe("none");
    }
    const config = resolveConfig({ agents: { analyst: {} } });
    for (const id of [undefined, "", "Analyst", "agent:analyst:main"]) {
      expect(() => resolveMxcAgentConfig(config, id, "agent")).toThrow(/canonical agentId/);
    }
    expect(() => resolveMxcAgentConfig(config, "analyst", "shared")).toThrow(
      /shared sandbox scope/,
    );
    expect(() => resolveMxcAgentConfig(config, "other", "shared")).not.toThrow();
    for (const scope of ["agent", "session"]) {
      expect(() => resolveMxcAgentConfig(config, "analyst", scope)).not.toThrow();
    }
  });
});
