import { describe, expect, it, vi } from "vitest";
import {
  deriveCopilotApiBaseUrlFromToken,
  resolveCopilotApiToken,
} from "./github-copilot-token.js";

describe("resolveCopilotApiToken", () => {
  it("derives native Copilot base URLs from Copilot proxy hints", () => {
    expect(
      deriveCopilotApiBaseUrlFromToken(
        "copilot-token;proxy-ep=https://proxy.individual.githubcopilot.com;",
      ),
    ).toBe("https://api.individual.githubcopilot.com");
    expect(deriveCopilotApiBaseUrlFromToken("copilot-token;proxy-ep=proxy.example.com;")).toBe(
      "https://api.example.com",
    );
    expect(deriveCopilotApiBaseUrlFromToken("copilot-token;proxy-ep=proxy.example.com:8443;")).toBe(
      "https://api.example.com",
    );
  });

  it("rejects malformed or non-http proxy hints", () => {
    expect(
      deriveCopilotApiBaseUrlFromToken("copilot-token;proxy-ep=javascript:alert(1);"),
    ).toBeNull();
    expect(deriveCopilotApiBaseUrlFromToken("copilot-token;proxy-ep=://bad;")).toBeNull();
  });

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

  it("sends IDE headers when exchanging the GitHub token", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        token: "copilot-token",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }),
    }));

    await resolveCopilotApiToken({
      githubToken: "github-token",
      cachePath: "/tmp/github-copilot-token-test.json",
      loadJsonFileImpl: () => undefined,
      saveJsonFileImpl: () => undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/copilot_internal/v2/token",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Accept: "application/json",
          Authorization: "Bearer github-token",
          "Editor-Version": "vscode/1.96.2",
          "User-Agent": "GitHubCopilotChat/0.26.7",
          "X-Github-Api-Version": "2025-04-01",
        }),
      }),
    );
  });
});
