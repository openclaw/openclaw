import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProviderEnv } from "./provider-env.js";

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
