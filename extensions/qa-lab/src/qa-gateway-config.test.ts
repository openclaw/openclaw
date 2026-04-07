import { describe, expect, it } from "vitest";
import { buildQaGatewayConfig } from "./qa-gateway-config.js";

function getPrimaryModel(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object" && "primary" in value) {
    const primary = (value as { primary?: unknown }).primary;
    return typeof primary === "string" ? primary : undefined;
  }
  return undefined;
}

describe("buildQaGatewayConfig", () => {
  it("keeps mock-openai as the default provider lane", () => {
    const cfg = buildQaGatewayConfig({
      bind: "loopback",
      gatewayPort: 18789,
      gatewayToken: "token",
      providerBaseUrl: "http://127.0.0.1:44080/v1",
      qaBusBaseUrl: "http://127.0.0.1:43124",
      workspaceDir: "/tmp/qa-workspace",
    });

    expect(getPrimaryModel(cfg.agents?.defaults?.model)).toBe("mock-openai/gpt-5.4");
    expect(cfg.models?.providers?.["mock-openai"]?.baseUrl).toBe("http://127.0.0.1:44080/v1");
    expect(cfg.plugins?.allow).toEqual(["memory-core", "qa-channel"]);
    expect(cfg.plugins?.entries?.["memory-core"]).toEqual({ enabled: true });
    expect(cfg.plugins?.entries?.openai).toBeUndefined();
  });

  it("uses built-in OpenAI provider wiring in live mode", () => {
    const cfg = buildQaGatewayConfig({
      bind: "loopback",
      gatewayPort: 18789,
      gatewayToken: "token",
      qaBusBaseUrl: "http://127.0.0.1:43124",
      workspaceDir: "/tmp/qa-workspace",
      providerMode: "live-openai",
      primaryModel: "openai/gpt-5.4",
      alternateModel: "openai/gpt-5.4",
    });

    expect(getPrimaryModel(cfg.agents?.defaults?.model)).toBe("openai/gpt-5.4");
    expect(getPrimaryModel(cfg.agents?.list?.[0]?.model)).toBe("openai/gpt-5.4");
    expect(cfg.models).toBeUndefined();
    expect(cfg.plugins?.allow).toEqual(["memory-core", "openai", "qa-channel"]);
    expect(cfg.plugins?.entries?.openai).toEqual({ enabled: true });
    expect(cfg.agents?.defaults?.models?.["openai/gpt-5.4"]).toEqual({
      params: { transport: "sse", openaiWsWarmup: false, fastMode: true },
    });
  });

  it("can disable control ui for suite-only gateway children", () => {
    const cfg = buildQaGatewayConfig({
      bind: "loopback",
      gatewayPort: 18789,
      gatewayToken: "token",
      qaBusBaseUrl: "http://127.0.0.1:43124",
      workspaceDir: "/tmp/qa-workspace",
      controlUiEnabled: false,
    });

    expect(cfg.gateway?.controlUi?.enabled).toBe(false);
    expect(cfg.gateway?.controlUi).not.toHaveProperty("allowInsecureAuth");
    expect(cfg.gateway?.controlUi).not.toHaveProperty("allowedOrigins");
  });
});
