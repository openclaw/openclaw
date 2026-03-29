import { describe, expect, it, vi } from "vitest";
import type { JiraCloudConfig } from "./config.js";
import { JiraCloudClient } from "./client.js";

function buildConfig(overrides: Partial<JiraCloudConfig> = {}): JiraCloudConfig {
  return {
    siteUrl: "https://example.atlassian.net",
    email: "bot@example.com",
    apiToken: "secret-token",
    requestTimeoutMs: 5_000,
    retryCount: 2,
    userAgent: "openclaw-jira-cloud/test",
    ...overrides,
  };
}

describe("jira client", () => {
  it("adds auth headers and parses successful json", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = new JiraCloudClient(buildConfig(), { fetchImpl: fetchImpl as never });
    const payload = await client.request<{ ok: boolean }>("/rest/api/3/myself");

    const call = fetchImpl.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(String(call[0])).toContain("/rest/api/3/myself");
    const headers = call[1].headers as Headers;
    expect(headers.get("Authorization")).toContain("Basic ");
    expect(payload.ok).toBe(true);
  });

  it("retries on 429 and then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ errorMessages: ["slow down"] }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "0" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const sleep = vi.fn(async () => {});
    const client = new JiraCloudClient(buildConfig(), {
      fetchImpl: fetchImpl as never,
      sleep,
    });
    const payload = await client.request<{ ok: boolean }>("/rest/api/3/project/search");
    expect(payload.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("maps auth failures without leaking secrets", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ errorMessages: ["invalid token"] }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    });
    const client = new JiraCloudClient(buildConfig(), { fetchImpl: fetchImpl as never });

    await expect(client.request("/rest/api/3/myself")).rejects.toMatchObject({
      code: "jira_auth_failed",
      status: 401,
    });
  });
});
