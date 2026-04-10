import type { StreamFn } from "@mariozechner/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __testing,
  createAnthropicAdvisorToolWrapper,
  createAnthropicBetaHeadersWrapper,
  createAnthropicFastModeWrapper,
  createAnthropicServiceTierWrapper,
  wrapAnthropicProviderStream,
} from "./stream-wrappers.js";

const CONTEXT_1M_BETA = "context-1m-2025-08-07";
const OAUTH_BETA = "oauth-2025-04-20";

function runWrapper(apiKey: string | undefined): Record<string, string> | undefined {
  const captured: { headers?: Record<string, string> } = {};
  const base: StreamFn = (_model, _context, options) => {
    captured.headers = options?.headers;
    return {} as never;
  };
  const wrapper = createAnthropicBetaHeadersWrapper(base, [CONTEXT_1M_BETA]);
  void wrapper(
    { provider: "anthropic", id: "claude-opus-4-6" } as never,
    {} as never,
    { apiKey } as never,
  );
  return captured.headers;
}

describe("anthropic stream wrappers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("strips context-1m for Claude CLI or legacy token auth and warns", () => {
    const warn = vi.spyOn(__testing.log, "warn").mockImplementation(() => undefined);
    const headers = runWrapper("sk-ant-oat01-123");
    expect(headers?.["anthropic-beta"]).toBeDefined();
    expect(headers?.["anthropic-beta"]).toContain(OAUTH_BETA);
    expect(headers?.["anthropic-beta"]).not.toContain(CONTEXT_1M_BETA);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("keeps context-1m for API key auth", () => {
    const warn = vi.spyOn(__testing.log, "warn").mockImplementation(() => undefined);
    const headers = runWrapper("sk-ant-api-123");
    expect(headers?.["anthropic-beta"]).toBeDefined();
    expect(headers?.["anthropic-beta"]).toContain(CONTEXT_1M_BETA);
    expect(warn).not.toHaveBeenCalled();
  });

  it("skips service_tier for OAuth token in composed stream chain", () => {
    const captured: { headers?: Record<string, string>; payload?: Record<string, unknown> } = {};
    const base: StreamFn = (model, _context, options) => {
      captured.headers = options?.headers;
      const payload = {} as Record<string, unknown>;
      options?.onPayload?.(payload as never, model as never);
      captured.payload = payload;
      return {} as never;
    };

    const wrapped = wrapAnthropicProviderStream({
      streamFn: base,
      modelId: "claude-sonnet-4-6",
      extraParams: { context1m: true, serviceTier: "auto" },
    } as never);

    void wrapped?.(
      { provider: "anthropic", api: "anthropic-messages", id: "claude-sonnet-4-6" } as never,
      {} as never,
      { apiKey: "sk-ant-oat01-oauth-token" } as never,
    );

    expect(captured.headers?.["anthropic-beta"]).toContain(OAUTH_BETA);
    expect(captured.headers?.["anthropic-beta"]).not.toContain(CONTEXT_1M_BETA);
    expect(captured.payload?.service_tier).toBeUndefined();
  });

  it("composes the anthropic provider stream chain from extra params", () => {
    const captured: { headers?: Record<string, string>; payload?: Record<string, unknown> } = {};
    const base: StreamFn = (model, _context, options) => {
      captured.headers = options?.headers;
      const payload = {} as Record<string, unknown>;
      options?.onPayload?.(payload as never, model as never);
      captured.payload = payload;
      return {} as never;
    };

    const wrapped = wrapAnthropicProviderStream({
      streamFn: base,
      modelId: "claude-sonnet-4-6",
      extraParams: { context1m: true, serviceTier: "auto" },
    } as never);

    void wrapped?.(
      { provider: "anthropic", api: "anthropic-messages", id: "claude-sonnet-4-6" } as never,
      {} as never,
      { apiKey: "sk-ant-api-123" } as never,
    );

    expect(captured.headers?.["anthropic-beta"]).toContain(CONTEXT_1M_BETA);
    expect(captured.payload).toMatchObject({ service_tier: "auto" });
  });
});

describe("createAnthropicFastModeWrapper", () => {
  function runFastModeWrapper(params: {
    apiKey?: string;
    provider?: string;
    api?: string;
    baseUrl?: string;
    enabled?: boolean;
  }): Record<string, unknown> | undefined {
    const captured: { payload?: Record<string, unknown> } = {};
    const base: StreamFn = (_model, _context, options) => {
      if (options?.onPayload) {
        const payload: Record<string, unknown> = {};
        options.onPayload(payload, _model);
        captured.payload = payload;
      }
      return {} as never;
    };

    const wrapper = createAnthropicFastModeWrapper(base, params.enabled ?? true);
    void wrapper(
      {
        provider: params.provider ?? "anthropic",
        api: params.api ?? "anthropic-messages",
        baseUrl: params.baseUrl,
        id: "claude-sonnet-4-6",
      } as never,
      {} as never,
      { apiKey: params.apiKey } as never,
    );
    return captured.payload;
  }

  it("does not inject service_tier for OAuth token", () => {
    const payload = runFastModeWrapper({ apiKey: "sk-ant-oat01-test-token" });
    expect(payload?.service_tier).toBeUndefined();
  });

  it("injects service_tier for regular API keys", () => {
    const payload = runFastModeWrapper({ apiKey: "sk-ant-api03-test-key" });
    expect(payload?.service_tier).toBe("auto");
  });

  it("injects service_tier=standard_only when disabled for API keys", () => {
    const payload = runFastModeWrapper({ apiKey: "sk-ant-api03-test-key", enabled: false });
    expect(payload?.service_tier).toBe("standard_only");
  });

  it("does not inject service_tier for non-anthropic provider", () => {
    const payload = runFastModeWrapper({
      apiKey: "sk-ant-api03-test-key",
      provider: "openai",
      api: "openai-completions",
    });
    expect(payload?.service_tier).toBeUndefined();
  });
});

describe("createAnthropicServiceTierWrapper", () => {
  function runServiceTierWrapper(params: {
    apiKey?: string;
    provider?: string;
    api?: string;
    serviceTier?: "auto" | "standard_only";
  }): Record<string, unknown> | undefined {
    const captured: { payload?: Record<string, unknown> } = {};
    const base: StreamFn = (_model, _context, options) => {
      if (options?.onPayload) {
        const payload: Record<string, unknown> = {};
        options.onPayload(payload, _model);
        captured.payload = payload;
      }
      return {} as never;
    };

    const wrapper = createAnthropicServiceTierWrapper(base, params.serviceTier ?? "auto");
    void wrapper(
      {
        provider: params.provider ?? "anthropic",
        api: params.api ?? "anthropic-messages",
        id: "claude-sonnet-4-6",
      } as never,
      {} as never,
      { apiKey: params.apiKey } as never,
    );
    return captured.payload;
  }

  it("does not inject service_tier for OAuth token", () => {
    const payload = runServiceTierWrapper({ apiKey: "sk-ant-oat01-test-token" });
    expect(payload?.service_tier).toBeUndefined();
  });

  it("injects service_tier for regular API keys", () => {
    const payload = runServiceTierWrapper({ apiKey: "sk-ant-api03-test-key" });
    expect(payload?.service_tier).toBe("auto");
  });

  it("injects service_tier=standard_only for regular API keys", () => {
    const payload = runServiceTierWrapper({
      apiKey: "sk-ant-api03-test-key",
      serviceTier: "standard_only",
    });
    expect(payload?.service_tier).toBe("standard_only");
  });

  it("does not inject service_tier for non-anthropic provider", () => {
    const payload = runServiceTierWrapper({
      apiKey: "sk-ant-api03-test-key",
      provider: "openai",
      api: "openai-completions",
    });
    expect(payload?.service_tier).toBeUndefined();
  });
});

describe("createAnthropicAdvisorToolWrapper", () => {
  function runAdvisorWrapper(params: { advisorModel?: string; existingTools?: unknown[] }): {
    payload?: Record<string, unknown>;
  } {
    const captured: { payload?: Record<string, unknown> } = {};
    const base: StreamFn = (model, _context, options) => {
      if (options?.onPayload) {
        const payload: Record<string, unknown> = {
          tools: params.existingTools ?? [{ name: "Read", type: "custom" }],
        };
        options.onPayload(payload, model);
        captured.payload = payload;
      }
      return {} as never;
    };

    const wrapper = createAnthropicAdvisorToolWrapper(
      base,
      params.advisorModel ?? "claude-sonnet-4-6",
    );
    void wrapper(
      { provider: "anthropic", api: "anthropic-messages", id: "claude-sonnet-4-6" } as never,
      {} as never,
      { apiKey: "sk-ant-api03-test-key" } as never,
    );
    return captured;
  }

  it("injects advisor tool definition into payload tools array", () => {
    const { payload } = runAdvisorWrapper({});
    const tools = payload?.tools as unknown[];
    expect(tools).toBeDefined();
    const advisorTool = tools.find(
      (t: any) => t.type === "advisor_20260301" && t.name === "advisor",
    );
    expect(advisorTool).toBeDefined();
    expect((advisorTool as any).model).toBe("claude-sonnet-4-6");
  });

  it("preserves existing tools when injecting advisor", () => {
    const existingTools = [
      { name: "Read", type: "custom" },
      { name: "Write", type: "custom" },
    ];
    const { payload } = runAdvisorWrapper({ existingTools });
    const tools = payload?.tools as unknown[];
    expect(tools).toHaveLength(3);
    expect(tools[0]).toEqual({ name: "Read", type: "custom" });
    expect(tools[1]).toEqual({ name: "Write", type: "custom" });
  });

  it("creates tools array if none exists in payload", () => {
    const captured: { payload?: Record<string, unknown> } = {};
    const base: StreamFn = (model, _context, options) => {
      if (options?.onPayload) {
        const payload: Record<string, unknown> = {};
        options.onPayload(payload, model);
        captured.payload = payload;
      }
      return {} as never;
    };
    const wrapper = createAnthropicAdvisorToolWrapper(base, "claude-sonnet-4-6");
    void wrapper(
      { provider: "anthropic", api: "anthropic-messages", id: "claude-sonnet-4-6" } as never,
      {} as never,
      { apiKey: "sk-ant-api03-test-key" } as never,
    );
    const tools = captured.payload?.tools as unknown[];
    expect(tools).toHaveLength(1);
  });
});

describe("advisor wrapper composition", () => {
  it("composes advisor wrapper into provider stream chain", () => {
    const captured: { headers?: Record<string, string>; payload?: Record<string, unknown> } = {};
    const base: StreamFn = (model, _context, options) => {
      captured.headers = options?.headers;
      const payload: Record<string, unknown> = {
        tools: [{ name: "Read", type: "custom" }],
      };
      options?.onPayload?.(payload as never, model as never);
      captured.payload = payload;
      return {} as never;
    };

    const wrapped = wrapAnthropicProviderStream({
      streamFn: base,
      modelId: "claude-sonnet-4-6",
      extraParams: { advisor: { enabled: true, model: "claude-haiku-4-5" } },
    } as never);

    void wrapped?.(
      { provider: "anthropic", api: "anthropic-messages", id: "claude-sonnet-4-6" } as never,
      {} as never,
      { apiKey: "sk-ant-api03-test-key" } as never,
    );

    expect(captured.headers?.["anthropic-beta"]).toContain("advisor-tool-2026-03-01");
    const tools = captured.payload?.tools as unknown[];
    const advisorTool = tools?.find((t: any) => t.name === "advisor");
    expect(advisorTool).toBeDefined();
  });

  it("does not inject advisor when not configured", () => {
    const captured: { headers?: Record<string, string>; payload?: Record<string, unknown> } = {};
    const base: StreamFn = (model, _context, options) => {
      captured.headers = options?.headers;
      const payload: Record<string, unknown> = {
        tools: [{ name: "Read", type: "custom" }],
      };
      options?.onPayload?.(payload as never, model as never);
      captured.payload = payload;
      return {} as never;
    };

    const wrapped = wrapAnthropicProviderStream({
      streamFn: base,
      modelId: "claude-sonnet-4-6",
      extraParams: {},
    } as never);

    void wrapped?.(
      { provider: "anthropic", api: "anthropic-messages", id: "claude-sonnet-4-6" } as never,
      {} as never,
      { apiKey: "sk-ant-api03-test-key" } as never,
    );

    const beta = captured.headers?.["anthropic-beta"] ?? "";
    expect(beta).not.toContain("advisor-tool-2026-03-01");
    const tools = captured.payload?.tools as unknown[];
    const advisorTool = tools?.find((t: any) => t.name === "advisor");
    expect(advisorTool).toBeUndefined();
  });

  it("enables advisor with shorthand boolean config", () => {
    const captured: { headers?: Record<string, string>; payload?: Record<string, unknown> } = {};
    const base: StreamFn = (model, _context, options) => {
      captured.headers = options?.headers;
      const payload: Record<string, unknown> = { tools: [] };
      options?.onPayload?.(payload as never, model as never);
      captured.payload = payload;
      return {} as never;
    };

    const wrapped = wrapAnthropicProviderStream({
      streamFn: base,
      modelId: "claude-sonnet-4-6",
      extraParams: { advisor: true },
    } as never);

    void wrapped?.(
      { provider: "anthropic", api: "anthropic-messages", id: "claude-sonnet-4-6" } as never,
      {} as never,
      { apiKey: "sk-ant-api03-test-key" } as never,
    );

    expect(captured.headers?.["anthropic-beta"]).toContain("advisor-tool-2026-03-01");
    const tools = captured.payload?.tools as unknown[];
    expect(tools?.find((t: any) => t.name === "advisor")).toBeDefined();
  });

  it("rejects non-Claude advisor model with warning", () => {
    const warn = vi.spyOn(__testing.log, "warn").mockImplementation(() => undefined);
    const captured: { headers?: Record<string, string>; payload?: Record<string, unknown> } = {};
    const base: StreamFn = (model, _context, options) => {
      captured.headers = options?.headers;
      const payload: Record<string, unknown> = { tools: [] };
      options?.onPayload?.(payload as never, model as never);
      captured.payload = payload;
      return {} as never;
    };

    const wrapped = wrapAnthropicProviderStream({
      streamFn: base,
      modelId: "claude-sonnet-4-6",
      extraParams: { advisor: { enabled: true, model: "gpt-4" } },
    } as never);

    void wrapped?.(
      { provider: "anthropic", api: "anthropic-messages", id: "claude-sonnet-4-6" } as never,
      {} as never,
      { apiKey: "sk-ant-api03-test-key" } as never,
    );

    // Advisor should not be injected for non-Claude models
    const beta = captured.headers?.["anthropic-beta"] ?? "";
    expect(beta).not.toContain("advisor-tool-2026-03-01");
    const tools = captured.payload?.tools as unknown[];
    expect(tools?.find((t: any) => t.name === "advisor")).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });
});
