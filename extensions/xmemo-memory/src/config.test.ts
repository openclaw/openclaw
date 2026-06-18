import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import {
  resolveXMemoMemoryConfig,
  resolveXMemoAgentInstanceId,
  DEFAULT_BASE_URL,
  DEFAULT_BUCKET,
  DEFAULT_AGENT_ID,
} from "./config.js";

function emptyConfig(): OpenClawConfig {
  return {
    plugins: { entries: { "xmemo-memory": { enabled: true, config: {} } } },
  } as OpenClawConfig;
}

function pluginConfig(config: Record<string, unknown>): OpenClawConfig {
  return {
    plugins: { entries: { "xmemo-memory": { enabled: true, config } } },
  } as OpenClawConfig;
}

describe("resolveXMemoMemoryConfig", () => {
  it("uses defaults when no config or env is provided", () => {
    const cfg = resolveXMemoMemoryConfig(emptyConfig(), {});
    expect(cfg.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(cfg.bucket).toBe(DEFAULT_BUCKET);
    expect(cfg.agentId).toBe(DEFAULT_AGENT_ID);
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.authMode).toBe("api-key");
    expect(cfg.autoCapture).toBe(false);
    expect(cfg.captureMaxChars).toBe(500);
    expect(cfg.recallMaxItems).toBe(8);
    expect(cfg.recallMaxTokens).toBe(1500);
  });

  it("reads config from plugins.entries[xmemo-memory].config", () => {
    const cfg = resolveXMemoMemoryConfig(
      pluginConfig({
        baseUrl: "https://xmemo.example.com",
        bucket: "work",
        scope: "team-a",
        apiKey: "cfg-key",
        authMode: "bearer",
        autoCapture: true,
        captureMaxChars: 1000,
        customTriggers: ["save this"],
      }),
      {},
    );
    expect(cfg.baseUrl).toBe("https://xmemo.example.com");
    expect(cfg.bucket).toBe("work");
    expect(cfg.scope).toBe("team-a");
    expect(cfg.apiKey).toBe("cfg-key");
    expect(cfg.authMode).toBe("bearer");
    expect(cfg.autoCapture).toBe(true);
    expect(cfg.captureMaxChars).toBe(1000);
    expect(cfg.customTriggers).toEqual(["save this"]);
  });

  it("falls back to env vars when config key is missing", () => {
    const cfg = resolveXMemoMemoryConfig(emptyConfig(), {
      XMEMO_KEY: "env-key",
      XMEMO_BASE_URL: "https://env.example.com",
      XMEMO_AGENT_ID: "env-agent",
    });
    expect(cfg.apiKey).toBe("env-key");
    expect(cfg.baseUrl).toBe("https://env.example.com");
    expect(cfg.agentId).toBe("env-agent");
  });

  it("prefers apiKey over deprecated token", () => {
    const cfg = resolveXMemoMemoryConfig(pluginConfig({ apiKey: "new", token: "old" }), {});
    expect(cfg.apiKey).toBe("new");
  });

  it("falls back to deprecated token when apiKey is missing", () => {
    const cfg = resolveXMemoMemoryConfig(pluginConfig({ token: "old" }), {});
    expect(cfg.apiKey).toBe("old");
  });

  it("normalizes authMode to api-key for invalid values", () => {
    const cfg = resolveXMemoMemoryConfig(pluginConfig({ authMode: "invalid" }), {});
    expect(cfg.authMode).toBe("api-key");
  });

  it("strips trailing slash from baseUrl", () => {
    const cfg = resolveXMemoMemoryConfig(pluginConfig({ baseUrl: "https://xmemo.dev/" }), {});
    expect(cfg.baseUrl).toBe("https://xmemo.dev");
  });
});

describe("resolveXMemoAgentInstanceId", () => {
  it("prefers env var", () => {
    const id = resolveXMemoAgentInstanceId({ XMEMO_AGENT_INSTANCE_ID: "stable-id" });
    expect(id).toBe("stable-id");
  });

  it("generates a process-local id when env is missing", () => {
    const id = resolveXMemoAgentInstanceId({});
    expect(id).toMatch(/^xmemo-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});
