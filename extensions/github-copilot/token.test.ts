import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ENTERPRISE_COPILOT_API_BASE_URL,
  deriveCopilotApiBaseUrlFromToken,
  isGitHubPAT,
  resolveCopilotApiToken,
} from "./token.js";

describe("github-copilot token", () => {
  const loadJsonFile = vi.fn();
  const saveJsonFile = vi.fn();
  const cachePath = "/tmp/openclaw-state/credentials/github-copilot.token.json";

  beforeEach(() => {
    loadJsonFile.mockClear();
    saveJsonFile.mockClear();
  });

  it("derives baseUrl from token", async () => {
    expect(deriveCopilotApiBaseUrlFromToken("token;proxy-ep=proxy.example.com;")).toBe(
      "https://api.example.com",
    );
    expect(deriveCopilotApiBaseUrlFromToken("token;proxy-ep=https://proxy.foo.bar;")).toBe(
      "https://api.foo.bar",
    );
  });

  it("uses cache when token is still valid", async () => {
    const now = Date.now();
    loadJsonFile.mockReturnValue({
      token: "cached;proxy-ep=proxy.example.com;",
      expiresAt: now + 60 * 60 * 1000,
      updatedAt: now,
    });

    const fetchImpl = vi.fn();
    const res = await resolveCopilotApiToken({
      githubToken: "gh",
      cachePath,
      loadJsonFileImpl: loadJsonFile,
      saveJsonFileImpl: saveJsonFile,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(res.token).toBe("cached;proxy-ep=proxy.example.com;");
    expect(res.baseUrl).toBe("https://api.example.com");
    expect(String(res.source)).toContain("cache:");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fetches and stores token when cache is missing", async () => {
    loadJsonFile.mockReturnValue(undefined);

    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        token: "fresh;proxy-ep=https://proxy.contoso.test;",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }),
    });

    const { resolveCopilotApiToken } = await import("./token.js");

    const res = await resolveCopilotApiToken({
      githubToken: "gh",
      cachePath,
      loadJsonFileImpl: loadJsonFile,
      saveJsonFileImpl: saveJsonFile,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(res.token).toBe("fresh;proxy-ep=https://proxy.contoso.test;");
    expect(res.baseUrl).toBe("https://api.contoso.test");
    expect(saveJsonFile).toHaveBeenCalledTimes(1);
  });

  it("uses Bearer prefix for OAuth tokens (ghu_)", async () => {
    loadJsonFile.mockReturnValue(undefined);

    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        token: "result-token",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }),
    });

    await resolveCopilotApiToken({
      githubToken: "ghu_abc123",
      cachePath,
      loadJsonFileImpl: loadJsonFile,
      saveJsonFileImpl: saveJsonFile,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const headers = fetchImpl.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe("Bearer ghu_abc123");
  });

  it("skips token exchange for PATs (github_pat_) and returns direct token", async () => {
    const fetchImpl = vi.fn();

    const res = await resolveCopilotApiToken({
      githubToken: "github_pat_abc123",
      cachePath,
      loadJsonFileImpl: loadJsonFile,
      saveJsonFileImpl: saveJsonFile,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(res.token).toBe("github_pat_abc123");
    expect(res.baseUrl).toBe(ENTERPRISE_COPILOT_API_BASE_URL);
    expect(res.source).toBe("pat:direct");
  });

  it("skips token exchange for classic PATs (ghp_) and returns direct token", async () => {
    const fetchImpl = vi.fn();

    const res = await resolveCopilotApiToken({
      githubToken: "ghp_abc123",
      cachePath,
      loadJsonFileImpl: loadJsonFile,
      saveJsonFileImpl: saveJsonFile,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(res.token).toBe("ghp_abc123");
    expect(res.baseUrl).toBe(ENTERPRISE_COPILOT_API_BASE_URL);
  });

  it("isGitHubPAT detects token types correctly", () => {
    expect(isGitHubPAT("github_pat_abc")).toBe(true);
    expect(isGitHubPAT("ghp_abc")).toBe(true);
    expect(isGitHubPAT("ghu_abc")).toBe(false);
    expect(isGitHubPAT("gho_abc")).toBe(false);
    expect(isGitHubPAT("some-random-token")).toBe(false);
  });
});
