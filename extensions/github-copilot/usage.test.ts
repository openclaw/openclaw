import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createProviderUsageFetch, makeResponse } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { fetchCopilotUsage } from "./usage.js";

function registerProvider() {
  const registerProviderMock = vi.fn<OpenClawPluginApi["registerProvider"]>();
  plugin.register(createTestPluginApi({ registerProvider: registerProviderMock }));
  return expectDefined(registerProviderMock.mock.calls[0]?.[0], "Copilot provider registration");
}

describe("GitHub Copilot usage credential routing", () => {
  it.each([
    { label: "plain public token", expectedDomain: "github.com" },
    {
      label: "plain token with configured tenant",
      configuredDomain: "config.ghe.com",
      expectedDomain: "config.ghe.com",
    },
    {
      label: "OAuth tenant before provider config",
      credentialDomain: "account.ghe.com",
      configuredDomain: "config.ghe.com",
      expectedDomain: "account.ghe.com",
    },
    {
      label: "public OAuth before provider config",
      credentialDomain: "github.com",
      configuredDomain: "config.ghe.com",
      expectedDomain: "github.com",
    },
    {
      label: "environment override before OAuth and config",
      credentialDomain: "account.ghe.com",
      configuredDomain: "config.ghe.com",
      envDomain: "override.ghe.com",
      expectedDomain: "override.ghe.com",
    },
  ])("uses the raw token and correct host for $label", async (testCase) => {
    const provider = registerProvider();
    const token = testCase.credentialDomain
      ? expectDefined(
          provider.formatApiKey,
          "Copilot OAuth formatter",
        )({
          type: "oauth",
          provider: "github-copilot",
          refresh: "durable-token",
          access: "old-access",
          expires: 0,
          enterpriseUrl: testCase.credentialDomain,
        })
      : "durable-token";
    const config: OpenClawConfig = testCase.configuredDomain
      ? {
          models: {
            providers: {
              "github-copilot": {
                baseUrl: "https://api.githubcopilot.com",
                models: [],
                params: { githubDomain: testCase.configuredDomain },
              },
            },
          },
        }
      : {};
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe(`https://api.${testCase.expectedDomain}/copilot_internal/user`);
      expect(request.headers.get("authorization")).toBe("token durable-token");
      return Response.json({
        copilot_plan: "business",
        quota_snapshots: { premium_interactions: { percent_remaining: 75 } },
      });
    });

    const result = await expectDefined(
      provider.fetchUsageSnapshot,
      "Copilot usage hook",
    )({
      config,
      env: testCase.envDomain ? { COPILOT_GITHUB_DOMAIN: testCase.envDomain } : {},
      provider: "github-copilot",
      token,
      timeoutMs: 5000,
      fetchFn,
    });

    expect(fetchFn).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      provider: "github-copilot",
      plan: "business",
      windows: [{ label: "Premium", usedPercent: 25 }],
    });
  });

  it.each([
    "openclaw-github-copilot-oauth:v1:invalid-json",
    'openclaw-github-copilot-oauth:v1:{"token":"durable-token","githubDomain":"attacker.example"}',
  ])("rejects invalid credential metadata before sending a request", async (token) => {
    const provider = registerProvider();
    const fetchFn = vi.fn<typeof fetch>();
    await expect(
      expectDefined(
        provider.fetchUsageSnapshot,
        "Copilot usage hook",
      )({
        config: {},
        env: {},
        provider: "github-copilot",
        token,
        timeoutMs: 5000,
        fetchFn,
      }),
    ).rejects.toThrow("Invalid GitHub Copilot legacy OAuth credential metadata");
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

  it("parses premium/chat usage from remaining percentages", async () => {
    const mockFetch = createProviderUsageFetch(async (_url, init) => {
      const headers = (init?.headers as Record<string, string> | undefined) ?? {};
      expect(headers.Authorization).toBe("token token");
      expect(headers["X-Github-Api-Version"]).toBe("2025-04-01");

      return makeResponse(200, {
        quota_snapshots: {
          premium_interactions: { percent_remaining: 20 },
          chat: { percent_remaining: 75 },
        },
        copilot_plan: "pro",
      });
    });

    const result = await fetchCopilotUsage("token", 5000, mockFetch);

    expect(result.plan).toBe("pro");
    expect(result.windows).toEqual([
      { label: "Premium", usedPercent: 80 },
      { label: "Chat", usedPercent: 25 },
    ]);
  });

  it("defaults missing snapshot values and clamps invalid remaining percentages", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, {
        quota_snapshots: {
          premium_interactions: { percent_remaining: null },
          chat: { percent_remaining: 140 },
        },
      }),
    );

    const result = await fetchCopilotUsage("token", 5000, mockFetch);

    expect(result.windows).toEqual([
      { label: "Premium", usedPercent: 100 },
      { label: "Chat", usedPercent: 0 },
    ]);
    expect(result.plan).toBeUndefined();
  });

  it("returns an empty window list when quota snapshots are missing", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, {
        copilot_plan: "free",
      }),
    );

    const result = await fetchCopilotUsage("token", 5000, mockFetch);

    expect(result).toEqual({
      provider: "github-copilot",
      displayName: "Copilot",
      windows: [],
      plan: "free",
    });
  });

  it.each([
    ["null", null],
    ["an array", []],
  ])("returns an empty window list for a non-object %s payload", async (_label, payload) => {
    const mockFetch = createProviderUsageFetch(async () => makeResponse(200, payload));

    const result = await fetchCopilotUsage("token", 5000, mockFetch);

    expect(result).toEqual({
      provider: "github-copilot",
      displayName: "Copilot",
      windows: [],
      plan: undefined,
    });
  });

  it("bounds the usage read and cancels the stream when the body exceeds the JSON byte cap", async () => {
    // Larger than the shared 16 MiB readProviderJsonResponse cap so the bounded reader cancels the
    // stream mid-flight; if the cap were removed the unbounded res.json() would buffer the whole body.
    const ONE_MIB = 1024 * 1024;
    const TOTAL_CHUNKS = 32; // 32 MiB advertised body, double the cap.
    const chunk = new Uint8Array(ONE_MIB);

    let bytesPulled = 0;
    let canceled = false;
    const makeOversizedJsonResponse = (): Response => {
      let pulled = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulled >= TOTAL_CHUNKS) {
            controller.close();
            return;
          }
          pulled += 1;
          bytesPulled += chunk.length;
          controller.enqueue(chunk);
        },
        cancel() {
          canceled = true;
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const mockFetch = createProviderUsageFetch(async () => makeOversizedJsonResponse());

    await expect(fetchCopilotUsage("token", 5000, mockFetch)).rejects.toThrow(
      /github-copilot-usage: JSON response exceeds/,
    );
    // The bounded reader cancels the body and never pulls the full advertised 32 MiB stream.
    expect(canceled).toBe(true);
    expect(bytesPulled).toBeLessThan(TOTAL_CHUNKS * ONE_MIB);
  });

  it.each([
    ["invalid JSON", "{"],
    ["invalid UTF-8", new Uint8Array([0xff])],
  ])("returns a stable error snapshot for %s in a successful response", async (_label, body) => {
    const mockFetch = createProviderUsageFetch(
      async () =>
        new Response(body, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    await expect(fetchCopilotUsage("token", 5000, mockFetch)).resolves.toEqual({
      provider: "github-copilot",
      displayName: "Copilot",
      windows: [],
      error: "Copilot returned unreadable usage data. Try refreshing usage later.",
    });
  });

  it("preserves response body transport failures", async () => {
    const failure = new TypeError("fixture connection closed");
    const mockFetch = createProviderUsageFetch(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(failure);
            },
          }),
          { status: 200 },
        ),
    );

    await expect(fetchCopilotUsage("token", 5000, mockFetch)).rejects.toBe(failure);
  });
});
