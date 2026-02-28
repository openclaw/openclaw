import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLAUDE_CONFIG_DIR_ENV,
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
