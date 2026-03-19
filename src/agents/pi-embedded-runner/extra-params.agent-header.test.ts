import type { Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { runExtraParamsCase } from "./extra-params.test-support.js";

function makeCfg(injectAgentHeader?: boolean): OpenClawConfig {
  return {
    models: {
      providers: {
        "my-proxy": {
          baseUrl: "http://localhost:8080/v1",
          models: [],
          ...(injectAgentHeader !== undefined ? { injectAgentHeader } : {}),
        },
      },
    },
  };
}

function applyAndCapture(params: {
  provider: string;
  agentId?: string;
  callerHeaders?: Record<string, string>;
  cfg?: OpenClawConfig;
}) {
  return runExtraParamsCase({
    applyModelId: "gpt-4o",
    applyProvider: params.provider,
    callerHeaders: params.callerHeaders,
    cfg: params.cfg ?? makeCfg(true),
    agentId: params.agentId,
    model: {
      api: "openai-completions",
      provider: params.provider,
      id: "gpt-4o",
    } as Model<"openai-completions">,
    payload: {},
  });
}

describe("extra-params: Agent ID header injection", () => {
  it("injects X-OpenClaw-Agent when injectAgentHeader is true and agentId is provided", () => {
    const { headers } = applyAndCapture({
      provider: "my-proxy",
      agentId: "main",
    });

    expect(headers?.["X-OpenClaw-Agent"]).toBe("main");
  });

  it("does NOT inject when injectAgentHeader is not set", () => {
    const { headers } = applyAndCapture({
      provider: "my-proxy",
      agentId: "main",
      cfg: makeCfg(),
    });

    expect(headers?.["X-OpenClaw-Agent"]).toBeUndefined();
  });

  it("does NOT inject when agentId is undefined", () => {
    const { headers } = applyAndCapture({
      provider: "my-proxy",
      agentId: undefined,
    });

    expect(headers?.["X-OpenClaw-Agent"]).toBeUndefined();
  });

  it("does NOT inject when injectAgentHeader is false", () => {
    const { headers } = applyAndCapture({
      provider: "my-proxy",
      agentId: "main",
      cfg: makeCfg(false),
    });

    expect(headers?.["X-OpenClaw-Agent"]).toBeUndefined();
  });

  it("overrides caller-supplied X-OpenClaw-Agent header", () => {
    const { headers } = applyAndCapture({
      provider: "my-proxy",
      agentId: "grace",
      callerHeaders: { "X-OpenClaw-Agent": "spoofed" },
    });

    expect(headers?.["X-OpenClaw-Agent"]).toBe("grace");
  });

  it("does NOT affect providers without matching config entry", () => {
    const { headers } = applyAndCapture({
      provider: "other-provider",
      agentId: "main",
      cfg: makeCfg(true),
    });

    expect(headers?.["X-OpenClaw-Agent"]).toBeUndefined();
  });
});
