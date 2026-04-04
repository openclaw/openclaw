import type { StreamFn } from "@mariozechner/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __testing,
  createAnthropicBetaHeadersWrapper,
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
  wrapper(
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

    wrapped?.(
      { provider: "anthropic", api: "anthropic-messages", id: "claude-sonnet-4-6" } as never,
      {} as never,
      { apiKey: "sk-ant-api-123" } as never,
    );

    expect(captured.headers?.["anthropic-beta"]).toContain(CONTEXT_1M_BETA);
    expect(captured.payload).toMatchObject({ service_tier: "auto" });
  });
});
