import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderUsageFetch, makeResponse } from "openclaw/plugin-sdk/test-env";
import { oversizedJsonResponse } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { registerProviderWithPluginConfig } from "./provider.test-support.js";
import { fetchCopilotUsage } from "./usage.js";

const registerProvider = () => registerProviderWithPluginConfig({});

type UsageOptions = Parameters<
  NonNullable<ReturnType<typeof registerProvider>["fetchUsageSnapshot"]>
>[0];

function fetchSnapshot(fetchFn: typeof fetch, options: Partial<UsageOptions> = {}) {
  const fetchUsage = expectDefined(registerProvider().fetchUsageSnapshot, "Copilot usage hook");
  return fetchUsage({
    config: {},
    env: {},
    provider: "github-copilot",
    token: "durable-token",
    timeoutMs: 5000,
    ...options,
    fetchFn,
  });
}

function quotas(premium: number | null, chat: number) {
  return {
    quota_snapshots: {
      premium_interactions: { percent_remaining: premium },
      chat: { percent_remaining: chat },
    },
  };
}

function usageWindows(premium: number, chat: number) {
  return [
    { label: "Premium", usedPercent: premium },
    { label: "Chat", usedPercent: chat },
  ];
}

describe("GitHub Copilot usage credential routing", () => {
  const configHost = "config.ghe.com",
    accountHost = "account.ghe.com",
    envHost = "override.ghe.com";
  it.each([
    ["github.com", undefined, undefined, undefined],
    [configHost, undefined, configHost, undefined],
    [accountHost, accountHost, configHost, undefined],
    ["github.com", "github.com", configHost, undefined],
    [envHost, accountHost, configHost, envHost],
  ])(
    "uses the raw token and correct host for %s",
    async (expectedDomain, credentialDomain, configuredDomain, envDomain) => {
      const provider = registerProvider();
      const formatKey = expectDefined(provider.formatApiKey, "Copilot OAuth formatter");
      const token = credentialDomain
        ? formatKey({
            type: "oauth",
            provider: "github-copilot",
            refresh: "durable-token",
            access: "old-access",
            expires: 0,
            enterpriseUrl: credentialDomain,
          })
        : "durable-token";
      const copilot = {
        baseUrl: "https://api.githubcopilot.com",
        models: [],
        params: { githubDomain: configuredDomain },
      };
      const config: OpenClawConfig = configuredDomain
        ? { models: { providers: { "github-copilot": copilot } } }
        : {};
      const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        expect(request.url).toBe(`https://api.${expectedDomain}/copilot_internal/user`);
        expect(request.headers.get("authorization")).toBe("token durable-token");
        return Response.json({
          copilot_plan: "business",
          quota_snapshots: { premium_interactions: { percent_remaining: 75 } },
        });
      });

      const result = await fetchSnapshot(fetchFn, {
        config,
        token,
        env: envDomain ? { COPILOT_GITHUB_DOMAIN: envDomain } : {},
      });

      expect(fetchFn).toHaveBeenCalledOnce();
      expect(result).toMatchObject({
        provider: "github-copilot",
        plan: "business",
        windows: [{ label: "Premium", usedPercent: 25 }],
      });
    },
  );

  it.each([
    "openclaw-github-copilot-oauth:v1:invalid-json",
    'openclaw-github-copilot-oauth:v1:{"token":"durable-token","githubDomain":"attacker.example"}',
  ])("rejects invalid credential metadata before sending a request", async (token) => {
    const fetchFn = vi.fn<typeof fetch>();
    await expect(fetchSnapshot(fetchFn, { token })).rejects.toThrow(
      "Invalid GitHub Copilot legacy OAuth credential metadata",
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("fetchCopilotUsage", () => {
  it("cancels failed response bodies", async () => {
    let canceled = false;
    const body = new ReadableStream({
      cancel() {
        canceled = true;
        throw new Error("stream already closed");
      },
    });
    const mockFetch = createProviderUsageFetch(async () => new Response(body, { status: 500 }));

    const result = await fetchCopilotUsage("token", 5000, mockFetch);

    expect(result.error).toBe("HTTP 500");
    expect(result.windows).toHaveLength(0);
    expect(canceled).toBe(true);
  });

  it.each([
    ["percentages", { ...quotas(20, 75), copilot_plan: "pro" }, "pro", usageWindows(80, 25)],
    ["missing/clamped values", quotas(null, 140), undefined, usageWindows(100, 0)],
    ["null payload", null, undefined, []],
  ] as const)("parses %s", async (_label, payload, plan, windows) => {
    const mockFetch = createProviderUsageFetch(async (_url, init) => {
      const headers = (init?.headers as Record<string, string> | undefined) ?? {};
      expect(headers.Authorization).toBe("token token");
      expect(headers["X-Github-Api-Version"]).toBe("2025-04-01");

      return makeResponse(200, payload);
    });

    expect(await fetchCopilotUsage("token", 5000, mockFetch)).toEqual({
      provider: "github-copilot",
      displayName: "Copilot",
      windows,
      plan,
    });
  });

  it("bounds the usage read and cancels the stream when the body exceeds the JSON byte cap", async () => {
    const body = oversizedJsonResponse({ chunkCount: 32, chunkSize: 1024 * 1024 });
    const mockFetch = createProviderUsageFetch(async () => body.response);

    await expect(fetchCopilotUsage("token", 5000, mockFetch)).rejects.toThrow(
      /github-copilot-usage: JSON response exceeds/,
    );
    expect(body.wasCanceled()).toBe(true);
    expect(body.getReadCount()).toBeLessThan(32);
  });
});
