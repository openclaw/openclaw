import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAnthropicUsage, resolveAnthropicUsageAuth } from "./usage.js";

const SETUP_TOKEN = `sk-ant-oat01-${"a".repeat(80)}`;
const OAUTH_TOKEN = `sk-ant-oat01-${"b".repeat(80)}`;
const API_KEY = "sk-ant-api03-test";

function requestUrl(input: string | URL | Request): URL {
  return new URL(input instanceof Request ? input.url : input);
}

async function resolveSetupUsageToken(env: NodeJS.ProcessEnv): Promise<string> {
  const result = await resolveAnthropicUsageAuth({
    config: {},
    env,
    provider: "anthropic",
    resolveApiKeyFromConfigAndStore: () => undefined,
    resolveOAuthToken: async () => ({ token: SETUP_TOKEN, profileType: "token" }),
  });
  if (!("token" in result)) {
    throw new Error("expected setup-token usage auth to resolve a token");
  }
  return result.token;
}

describe("Anthropic setup-token usage", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("skips a stored setup-token profile without a supported usage fallback", async () => {
    const resolveOAuthToken = vi.fn(async () => ({
      token: SETUP_TOKEN,
      profileType: "token" as const,
    }));
    const result = await resolveAnthropicUsageAuth({
      config: {},
      env: {},
      provider: "anthropic",
      resolveApiKeyFromConfigAndStore: () => undefined,
      resolveOAuthToken,
    });

    expect(result).toEqual({ handled: true });
    expect(resolveOAuthToken).toHaveBeenCalledTimes(1);
  });

  it("does not issue an OAuth usage request for a skipped setup-token profile", async () => {
    const fetchFn = vi.fn(async () => new Response("unexpected", { status: 500 }));
    const auth = await resolveAnthropicUsageAuth({
      config: {},
      env: {},
      provider: "anthropic",
      resolveApiKeyFromConfigAndStore: () => undefined,
      resolveOAuthToken: async () => ({ token: SETUP_TOKEN, profileType: "token" }),
    });

    expect(auth).toEqual({ handled: true });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("uses configured claude.ai web-session fallback for a setup-token profile", async () => {
    vi.stubEnv("CLAUDE_AI_SESSION_KEY", "sk-ant-session-key");
    const token = await resolveSetupUsageToken(process.env);
    expect(token).not.toBe(SETUP_TOKEN);

    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      expect(url.hostname).not.toBe("api.anthropic.com");
      if (url.pathname === "/api/organizations") {
        return new Response(JSON.stringify([{ uuid: "org-123" }]), { status: 200 });
      }
      if (url.pathname === "/api/organizations/org-123/usage") {
        return new Response(JSON.stringify({ five_hour: { utilization: 17 } }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await fetchAnthropicUsage({
      config: {},
      env: process.env,
      provider: "anthropic",
      token,
      timeoutMs: 5_000,
      fetchFn: fetchFn as typeof fetch,
    });

    expect(result.error).toBeUndefined();
    expect(result.windows).toEqual([{ label: "5h", usedPercent: 17, resetAt: undefined }]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("surfaces configured claude.ai web-session fallback failures", async () => {
    vi.stubEnv("CLAUDE_AI_SESSION_KEY", "sk-ant-session-key");
    const token = await resolveSetupUsageToken(process.env);
    const fetchFn = vi.fn(async () => new Response("unauthorized", { status: 401 }));

    const result = await fetchAnthropicUsage({
      config: {},
      env: process.env,
      provider: "anthropic",
      token,
      timeoutMs: 5_000,
      fetchFn: fetchFn as typeof fetch,
    });

    expect(result).toMatchObject({
      provider: "anthropic",
      displayName: "Claude",
      windows: [],
      error: "Claude web usage unavailable",
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("keeps existing static API-key profiles off the setup-token skip path", async () => {
    const resolveOAuthToken = vi.fn(async () => null);
    const result = await resolveAnthropicUsageAuth({
      config: {},
      env: {},
      provider: "anthropic",
      resolveApiKeyFromConfigAndStore: () => API_KEY,
      resolveApiKeyCandidatesFromConfigAndStore: async () => [API_KEY],
      resolveOAuthToken,
    });

    expect(result).toEqual({ handled: true });
    expect(resolveOAuthToken).toHaveBeenCalledTimes(1);
  });

  it("does not suppress a working static oat01 credential without a stored token profile", async () => {
    const resolveOAuthToken = vi.fn(async () => null);
    const result = await resolveAnthropicUsageAuth({
      config: {},
      env: {},
      provider: "anthropic",
      resolveApiKeyFromConfigAndStore: () => SETUP_TOKEN,
      resolveApiKeyCandidatesFromConfigAndStore: async () => [SETUP_TOKEN],
      resolveOAuthToken,
    });

    expect(result).toEqual({ token: SETUP_TOKEN });
    expect(resolveOAuthToken).toHaveBeenCalledTimes(1);
  });

  it("preserves a preferred OAuth profile when a lower-priority setup token coexists", async () => {
    const resolveOAuthToken = vi.fn(async () => ({
      token: OAUTH_TOKEN,
      email: "user@example.com",
      profileType: "oauth" as const,
    }));
    const result = await resolveAnthropicUsageAuth({
      config: {},
      env: { CLAUDE_AI_SESSION_KEY: "sk-ant-session-key" },
      provider: "anthropic",
      resolveApiKeyFromConfigAndStore: () => SETUP_TOKEN,
      resolveApiKeyCandidatesFromConfigAndStore: async () => [SETUP_TOKEN],
      resolveOAuthToken,
    });

    expect(result).toEqual({
      token: OAUTH_TOKEN,
      email: "user@example.com",
      profileType: "oauth",
    });
    expect(resolveOAuthToken).toHaveBeenCalledTimes(1);
  });

  it("keeps an oat01 OAuth profile on the OAuth path even when a setup-token candidate exists", async () => {
    const resolveOAuthToken = vi.fn(async () => ({
      token: SETUP_TOKEN,
      profileType: "oauth" as const,
    }));
    const result = await resolveAnthropicUsageAuth({
      config: {},
      env: {},
      provider: "anthropic",
      resolveApiKeyFromConfigAndStore: () => SETUP_TOKEN,
      resolveApiKeyCandidatesFromConfigAndStore: async () => [SETUP_TOKEN],
      resolveOAuthToken,
    });

    expect(result).toEqual({ token: SETUP_TOKEN, profileType: "oauth" });
    expect(resolveOAuthToken).toHaveBeenCalledTimes(1);
  });

  it("preserves OAuth usage for a full-length sk-ant-oat token without setup-token provenance", async () => {
    vi.stubEnv("CLAUDE_AI_SESSION_KEY", "");
    vi.stubEnv("CLAUDE_WEB_SESSION_KEY", "");
    vi.stubEnv("CLAUDE_WEB_COOKIE", "");
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      expect(url.hostname).toBe("api.anthropic.com");
      expect(url.pathname).toBe("/api/oauth/usage");
      return new Response(JSON.stringify({ five_hour: { utilization: 23 } }), { status: 200 });
    });

    const result = await fetchAnthropicUsage({
      config: {},
      env: process.env,
      provider: "anthropic",
      token: SETUP_TOKEN,
      timeoutMs: 5_000,
      fetchFn: fetchFn as typeof fetch,
    });

    expect(result.error).toBeUndefined();
    expect(result.windows).toEqual([{ label: "5h", usedPercent: 23, resetAt: undefined }]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
