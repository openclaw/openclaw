import type { StreamFn } from "@mariozechner/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __testing, createAnthropicBetaHeadersWrapper } from "./stream-wrappers.js";

const CONTEXT_1M_BETA = "context-1m-2025-08-07";
const OAUTH_BETA = "oauth-2025-04-20";
const CLAUDE_CODE_BETA = "claude-code-20250219";
const DEFAULT_BETAS = ["fine-grained-tool-streaming-2025-05-14", "interleaved-thinking-2025-05-14"];

function runWrapper(
  apiKey: string | undefined,
  isOAuthSetupTime?: boolean,
  betas: string[] = [CONTEXT_1M_BETA],
): Record<string, string> | undefined {
  const captured: { headers?: Record<string, string> } = {};
  const base: StreamFn = (_model, _context, options) => {
    captured.headers = options?.headers;
    return {} as never;
  };
  const wrapper = createAnthropicBetaHeadersWrapper(base, betas, isOAuthSetupTime);
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

  it("strips context-1m for subscription setup-token auth and warns", () => {
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

  it("injects OAuth betas via isOAuthSetupTime when options.apiKey is undefined", () => {
    const warn = vi.spyOn(__testing.log, "warn").mockImplementation(() => undefined);
    // Production scenario: options.apiKey is undefined, OAuth detected at setup time
    const headers = runWrapper(undefined, true);
    expect(headers?.["anthropic-beta"]).toContain(OAUTH_BETA);
    expect(headers?.["anthropic-beta"]).toContain(CLAUDE_CODE_BETA);
    expect(headers?.["anthropic-beta"]).not.toContain(CONTEXT_1M_BETA);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("injects default betas for non-OAuth when options.apiKey is undefined", () => {
    const headers = runWrapper(undefined, false);
    expect(headers?.["anthropic-beta"]).toBeDefined();
    expect(headers?.["anthropic-beta"]).toContain(CONTEXT_1M_BETA);
    for (const beta of DEFAULT_BETAS) {
      expect(headers?.["anthropic-beta"]).toContain(beta);
    }
    expect(headers?.["anthropic-beta"]).not.toContain(OAUTH_BETA);
  });

  it("injects OAuth betas with empty user betas when isOAuthSetupTime is true", () => {
    // Scenario: OAuth user with no context1m or explicit betas configured
    const headers = runWrapper(undefined, true, []);
    expect(headers?.["anthropic-beta"]).toContain(OAUTH_BETA);
    expect(headers?.["anthropic-beta"]).toContain(CLAUDE_CODE_BETA);
    for (const beta of DEFAULT_BETAS) {
      expect(headers?.["anthropic-beta"]).toContain(beta);
    }
  });

  it("injects default betas with empty user betas when isOAuthSetupTime is false", () => {
    // Scenario: API key user with no context1m or explicit betas configured
    const headers = runWrapper(undefined, false, []);
    for (const beta of DEFAULT_BETAS) {
      expect(headers?.["anthropic-beta"]).toContain(beta);
    }
    expect(headers?.["anthropic-beta"]).not.toContain(OAUTH_BETA);
  });
});
