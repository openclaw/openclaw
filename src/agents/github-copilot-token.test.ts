import { describe, expect, it, vi } from "vitest";
import {
  ENTERPRISE_COPILOT_API_BASE_URL,
  isGitHubPAT,
  resolveCopilotApiToken,
} from "./github-copilot-token.js";

describe("isGitHubPAT", () => {
  it("returns true for fine-grained PATs (github_pat_*)", () => {
    expect(isGitHubPAT("github_pat_abc123")).toBe(true);
  });

  it("returns true for classic PATs (ghp_*)", () => {
    expect(isGitHubPAT("ghp_abc123")).toBe(true);
  });

  it("returns false for OAuth tokens (ghu_*)", () => {
    expect(isGitHubPAT("ghu_abc123")).toBe(false);
  });

  it("returns false for GitHub App tokens (ghs_*)", () => {
    expect(isGitHubPAT("ghs_abc123")).toBe(false);
  });

  it("returns false for empty strings", () => {
    expect(isGitHubPAT("")).toBe(false);
  });

  it("returns false for arbitrary tokens", () => {
    expect(isGitHubPAT("sk-abc123")).toBe(false);
  });
});

describe("resolveCopilotApiToken", () => {
  it("treats 11-digit expires_at values as seconds epochs", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        token: "copilot-token",
        expires_at: 12_345_678_901,
      }),
    }));

    const result = await resolveCopilotApiToken({
      githubToken: "github-token",
      cachePath: "/tmp/github-copilot-token-test.json",
      loadJsonFileImpl: () => undefined,
      saveJsonFileImpl: () => undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.expiresAt).toBe(12_345_678_901_000);
  });

  it("skips token exchange for PATs (github_pat_*)", async () => {
    const fetchImpl = vi.fn();

    const result = await resolveCopilotApiToken({
      githubToken: "github_pat_abc123_secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      loadJsonFileImpl: () => undefined,
      saveJsonFileImpl: () => undefined,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.token).toBe("github_pat_abc123_secret");
    expect(result.expiresAt).toBe(Number.MAX_SAFE_INTEGER);
    expect(result.source).toBe("pat:direct");
    expect(result.baseUrl).toBe(ENTERPRISE_COPILOT_API_BASE_URL);
  });

  it("skips token exchange for classic PATs (ghp_*)", async () => {
    const fetchImpl = vi.fn();

    const result = await resolveCopilotApiToken({
      githubToken: "ghp_classic123",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      loadJsonFileImpl: () => undefined,
      saveJsonFileImpl: () => undefined,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.token).toBe("ghp_classic123");
    expect(result.source).toBe("pat:direct");
  });

  it("still uses token exchange for OAuth tokens (ghu_*)", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        token: "exchanged-token",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }),
    }));

    const result = await resolveCopilotApiToken({
      githubToken: "ghu_oauth_token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      cachePath: "/tmp/github-copilot-token-test-oauth.json",
      loadJsonFileImpl: () => undefined,
      saveJsonFileImpl: () => undefined,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(result.token).toBe("exchanged-token");
    expect(result.source).toContain("fetched:");
    const call = fetchImpl.mock.calls[0] as unknown as [
      string,
      { headers?: Record<string, string> },
    ];
    expect(call[1]?.headers?.Authorization).toBe("Bearer ghu_oauth_token");
  });
});
