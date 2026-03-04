import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLAUDE_CONFIG_DIR_ENV,
  buildProviderEnv,
  resolveClaudeConfigDir,
  resolveClaudeSubprocessEnv,
} from "./config.js";

describe("claude-sdk config dir resolution", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers claudeSdk.configDir over process env", () => {
    vi.stubEnv(CLAUDE_CONFIG_DIR_ENV, "/tmp/from-env");
    const resolved = resolveClaudeConfigDir({
      claudeSdkConfig: { configDir: "/tmp/from-config" },
    });
    expect(resolved).toBe("/tmp/from-config");
  });

  it("falls back to process env when claudeSdk.configDir is absent", () => {
    vi.stubEnv(CLAUDE_CONFIG_DIR_ENV, "/tmp/from-env");
    const resolved = resolveClaudeConfigDir({});
    expect(resolved).toBe("/tmp/from-env");
  });

  it("returns undefined when no config dir is configured", () => {
    const resolved = resolveClaudeConfigDir({ processEnv: {} });
    expect(resolved).toBeUndefined();
  });
});

describe("resolveClaudeSubprocessEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns undefined when no provider env exists and no config dir is configured", () => {
    const env = resolveClaudeSubprocessEnv({ processEnv: {} });
    expect(env).toBeUndefined();
  });

  it("passes process CLAUDE_CONFIG_DIR into provider env when no config override exists", () => {
    vi.stubEnv(CLAUDE_CONFIG_DIR_ENV, "/tmp/from-env");
    const env = resolveClaudeSubprocessEnv({
      providerEnv: { FOO: "bar" },
    });
    expect(env).toEqual({
      FOO: "bar",
      CLAUDE_CONFIG_DIR: "/tmp/from-env",
    });
  });

  it("applies claudeSdk.configDir over process env when provider env exists", () => {
    vi.stubEnv(CLAUDE_CONFIG_DIR_ENV, "/tmp/from-env");
    const env = resolveClaudeSubprocessEnv({
      providerEnv: { FOO: "bar" },
      claudeSdkConfig: { configDir: "/tmp/from-config" },
    });
    expect(env).toEqual({
      FOO: "bar",
      CLAUDE_CONFIG_DIR: "/tmp/from-config",
    });
  });

  it("strips stale CLAUDE_CONFIG_DIR from provider env when no source sets it", () => {
    const env = resolveClaudeSubprocessEnv({
      processEnv: {},
      providerEnv: { FOO: "bar", CLAUDE_CONFIG_DIR: "/tmp/stale" },
    });
    expect(env).toEqual({ FOO: "bar" });
  });

  it("builds passthrough env when only claudeSdk.configDir is configured", () => {
    vi.stubEnv("FOO", "bar");
    const env = resolveClaudeSubprocessEnv({
      claudeSdkConfig: { configDir: "/tmp/from-config" },
    });
    expect(env).toBeDefined();
    expect(env?.FOO).toBe("bar");
    expect(env?.CLAUDE_CONFIG_DIR).toBe("/tmp/from-config");
  });
});

describe("buildProviderEnv", () => {
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-inherited");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns inherited env with anthropic credentials stripped", () => {
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "tok-ant-inherited");
    vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "oauth-ant-inherited");
    vi.stubEnv("FOO_KEEP", "keep-me");
    const env = buildProviderEnv();
    expect(env).toBeDefined();
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(env["ANTHROPIC_AUTH_TOKEN"]).toBeUndefined();
    expect(env["ANTHROPIC_OAUTH_TOKEN"]).toBeUndefined();
    expect(env["FOO_KEEP"]).toBe("keep-me");
  });

  it("applies traffic guardrails", () => {
    const env = buildProviderEnv();
    expect(env["CLAUDE_CODE_ENABLE_TELEMETRY"]).toBe("0");
    expect(env["DISABLE_TELEMETRY"]).toBe("1");
    expect(env["DISABLE_BUG_COMMAND"]).toBe("1");
    expect(env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"]).toBe("1");
  });
});
