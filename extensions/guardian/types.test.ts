import { describe, it, expect } from "vitest";
import {
  resolveConfig,
  parseModelRef,
  resolveGuardianModelRef,
  GUARDIAN_DEFAULTS,
} from "./types.js";

describe("types — resolveConfig", () => {
  it("returns defaults when raw is undefined", () => {
    const config = resolveConfig(undefined);
    expect(config.model).toBeUndefined();
    expect(config.watched_tools).toEqual(GUARDIAN_DEFAULTS.watched_tools);
    expect(config.timeout_ms).toBe(GUARDIAN_DEFAULTS.timeout_ms);
    expect(config.fallback_on_error).toBe(GUARDIAN_DEFAULTS.fallback_on_error);
    expect(config.mode).toBe(GUARDIAN_DEFAULTS.mode);
  });

  it("returns defaults when raw is empty", () => {
    const config = resolveConfig({});
    expect(config.model).toBeUndefined();
    expect(config.watched_tools).toEqual(GUARDIAN_DEFAULTS.watched_tools);
  });

  it("resolves model string", () => {
    const config = resolveConfig({ model: "kimi/moonshot-v1-8k" });
    expect(config.model).toBe("kimi/moonshot-v1-8k");
  });

  it("resolves model as undefined for empty string", () => {
    const config = resolveConfig({ model: "" });
    expect(config.model).toBeUndefined();
  });

  it("overrides defaults with explicit values", () => {
    const config = resolveConfig({
      model: "openai/gpt-4o-mini",
      watched_tools: ["exec"],
      timeout_ms: 3000,
      fallback_on_error: "block",
      log_decisions: false,
      mode: "audit",
      max_user_messages: 5,
      max_arg_length: 200,
    });

    expect(config.model).toBe("openai/gpt-4o-mini");
    expect(config.watched_tools).toEqual(["exec"]);
    expect(config.timeout_ms).toBe(3000);
    expect(config.fallback_on_error).toBe("block");
    expect(config.log_decisions).toBe(false);
    expect(config.mode).toBe("audit");
    expect(config.max_user_messages).toBe(5);
    expect(config.max_arg_length).toBe(200);
  });

  it("uses defaults for invalid types", () => {
    const config = resolveConfig({
      timeout_ms: "not a number",
      log_decisions: "not a boolean",
      max_user_messages: null,
    });

    expect(config.timeout_ms).toBe(GUARDIAN_DEFAULTS.timeout_ms);
    expect(config.log_decisions).toBe(GUARDIAN_DEFAULTS.log_decisions);
    expect(config.max_user_messages).toBe(GUARDIAN_DEFAULTS.max_user_messages);
  });

  it("normalizes fallback_on_error to allow for non-block values", () => {
    const config = resolveConfig({ fallback_on_error: "invalid" });
    expect(config.fallback_on_error).toBe("allow");
  });

  it("normalizes mode to enforce for non-audit values", () => {
    const config = resolveConfig({ mode: "invalid" });
    expect(config.mode).toBe("enforce");
  });
});

describe("types — parseModelRef", () => {
  it("parses provider/model", () => {
    expect(parseModelRef("kimi/moonshot-v1-8k")).toEqual({
      provider: "kimi",
      modelId: "moonshot-v1-8k",
    });
  });

  it("parses provider with complex model ids", () => {
    expect(parseModelRef("ollama/llama3.1:8b")).toEqual({
      provider: "ollama",
      modelId: "llama3.1:8b",
    });
  });

  it("handles model ids with slashes (nested paths)", () => {
    expect(parseModelRef("openai/gpt-4o-mini")).toEqual({
      provider: "openai",
      modelId: "gpt-4o-mini",
    });
  });

  it("returns undefined for invalid formats", () => {
    expect(parseModelRef("")).toBeUndefined();
    expect(parseModelRef("no-slash")).toBeUndefined();
    expect(parseModelRef("/no-provider")).toBeUndefined();
    expect(parseModelRef("no-model/")).toBeUndefined();
  });
});

describe("types — resolveGuardianModelRef", () => {
  it("uses plugin config model when provided", () => {
    const config = resolveConfig({ model: "kimi/moonshot-v1-8k" });
    const result = resolveGuardianModelRef(config, {});
    expect(result).toBe("kimi/moonshot-v1-8k");
  });

  it("falls back to main agent model string", () => {
    const config = resolveConfig({});
    const result = resolveGuardianModelRef(config, {
      agents: { defaults: { model: { primary: "openai/gpt-4o" } } },
    });
    expect(result).toBe("openai/gpt-4o");
  });

  it("returns undefined when no model is available", () => {
    const config = resolveConfig({});
    const result = resolveGuardianModelRef(config, {});
    expect(result).toBeUndefined();
  });

  it("plugin config takes priority over main agent model", () => {
    const config = resolveConfig({ model: "kimi/moonshot-v1-8k" });
    const result = resolveGuardianModelRef(config, {
      agents: { defaults: { model: { primary: "openai/gpt-4o" } } },
    });
    expect(result).toBe("kimi/moonshot-v1-8k");
  });
});
