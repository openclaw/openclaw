import fs from "node:fs";
import {
  type JsonSchemaObject,
  validateJsonSchemaValue,
} from "openclaw/plugin-sdk/json-schema-runtime";
import { describe, expect, it } from "vitest";
import { applyCliRuntimeRecallTimeoutDefault, normalizePluginConfig } from "./config.js";

const manifest = JSON.parse(
  fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf-8"),
) as { configSchema: JsonSchemaObject };

describe("active-memory runtime config normalization", () => {
  it("normalizes circuit breaker config with defaults", () => {
    const config = normalizePluginConfig({});
    expect(config.circuitBreakerMaxTimeouts).toBe(3);
    expect(config.circuitBreakerCooldownMs).toBe(60_000);
  });

  it("normalizes explicit fast-mode overrides and ignores invalid values", () => {
    expect(normalizePluginConfig({}).fastMode).toBeUndefined();
    expect(normalizePluginConfig({ fastMode: true }).fastMode).toBe(true);
    expect(normalizePluginConfig({ fastMode: false }).fastMode).toBe(false);
    expect(normalizePluginConfig({ fastMode: "auto" }).fastMode).toBe("auto");
    expect(normalizePluginConfig({ fastMode: "on" }).fastMode).toBeUndefined();
  });

  it("normalizes setup grace config with a zero default and bounded opt-in", () => {
    expect(normalizePluginConfig({}).setupGraceTimeoutMs).toBe(0);
    expect(normalizePluginConfig({ setupGraceTimeoutMs: 30_001 }).setupGraceTimeoutMs).toBe(30_000);
    expect(normalizePluginConfig({ setupGraceTimeoutMs: -1 }).setupGraceTimeoutMs).toBe(0);
  });

  it("clamps circuit breaker config within valid ranges", () => {
    const config = normalizePluginConfig({
      circuitBreakerMaxTimeouts: 0,
      circuitBreakerCooldownMs: 1000,
    });
    expect(config.circuitBreakerMaxTimeouts).toBe(1);
    expect(config.circuitBreakerCooldownMs).toBe(5000);
  });
});

describe("active-memory manifest config schema", () => {
  it("preserves an explicit timeout for CLI recall", () => {
    const config = normalizePluginConfig({ timeoutMs: 20_000 });
    expect(config.timeoutMsIsDefault).toBe(false);
    expect(applyCliRuntimeRecallTimeoutDefault(config, true).timeoutMs).toBe(20_000);
  });

  it("defaults runtime mode to escalate", () => {
    expect(normalizePluginConfig({}).mode).toBe("escalate");
  });

  it.each([
    // Mode-only payloads must stay valid for partial configuration updates.
    ["escalate mode", { mode: "escalate" }, true],
    ["always mode", { mode: "always" }, true],
    ["off mode", { mode: "off" }, true],
    [
      "model fallback",
      { modelFallback: "google/gemini-3-flash", modelFallbackPolicy: "resolved-only" },
      true,
    ],
    ["fast mode on", { fastMode: true }, true],
    ["fast mode off", { fastMode: false }, true],
    ["automatic fast mode", { fastMode: "auto" }, true],
    ["unsupported fast mode", { fastMode: "on" }, false],
    ["custom tools", { toolsAllow: ["lcm_grep", "lcm_describe", "lcm_expand_query"] }, true],
    ["reserved tools", { toolsAllow: ["*", "group:plugins"] }, false],
    ["timeout ceiling", { timeoutMs: 120_000 }, true],
    ["setup grace ceiling", { setupGraceTimeoutMs: 30_000 }, true],
    ["explicit chat type", { allowedChatTypes: ["direct", "explicit"] }, true],
    ["max thinking", { thinking: "max" }, true],
    ["timeout above ceiling", { timeoutMs: 120_001 }, false],
    ["setup grace above ceiling", { setupGraceTimeoutMs: 30_001 }, false],
    ["unknown chat type", { allowedChatTypes: ["direct", "portal"] }, false],
  ] as const)("validates %s", (_name, value, expected) => {
    const result = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "active-memory.manifest",
      value: "mode" in value ? value : { enabled: true, agents: ["main"], ...value },
    });
    expect(result.ok).toBe(expected);
  });
});
