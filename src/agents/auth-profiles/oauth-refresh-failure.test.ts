/**
 * Tests OAuth refresh failure hints.
 * Verifies typed and message-based classification plus sanitized login command
 * generation.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { FailoverError } from "../failover-error.js";
import {
  buildOAuthRefreshFailureLoginCommand,
  classifyOAuthRefreshFailure,
  classifyOAuthRefreshFailureError,
  OAuthRefreshFailureError,
} from "./oauth-refresh-failure.js";

describe("oauth refresh failure hints", () => {
  it("builds OpenAI refresh-failure login hints", () => {
    expect(
      classifyOAuthRefreshFailure("OAuth token refresh failed for openai: invalid_grant"),
    ).toEqual({
      provider: "openai",
      reason: "invalid_grant",
    });
    expect(buildOAuthRefreshFailureLoginCommand("openai")).toBe(
      "openclaw models auth login --provider openai",
    );
  });

  it("classifies typed refresh failures without parsing the display message", () => {
    expect(
      classifyOAuthRefreshFailureError(
        new OAuthRefreshFailureError({
          provider: "openai",
          message: "invalid_grant",
        }),
      ),
    ).toEqual({
      provider: "openai",
      reason: "invalid_grant",
    });
  });

  it("classifies claude-cli subprocess 401 OAuth expiry as a provider refresh failure", () => {
    // Error message format emitted by the claude subprocess when its stored
    // OAuth token has expired, forwarded through the FailoverError message.
    const claudeCliFailureMessage =
      "Provider claude-cli failed: Failed to authenticate. API Error: 401 Invalid authentication credentials";
    expect(classifyOAuthRefreshFailure(claudeCliFailureMessage)).toEqual({
      provider: "claude-cli",
      reason: "revoked",
    });
    expect(buildOAuthRefreshFailureLoginCommand("claude-cli")).toBe(
      "openclaw models auth login --provider anthropic --method cli",
    );
  });

  it("classifies structured claude-cli 401 failures even when the display message omits the provider", () => {
    const error = new FailoverError(
      "Failed to authenticate. API Error: 401 Invalid authentication credentials",
      {
        reason: "auth",
        provider: "claude-cli",
        model: "claude-sonnet-4-20250514",
        status: 401,
      },
    );

    expect(classifyOAuthRefreshFailureError(error)).toEqual({
      provider: "claude-cli",
      reason: "revoked",
    });
  });

  it("does not classify a 401 auth failure without claude-cli prefix as a refresh failure", () => {
    // A generic 401 from another provider should NOT be treated as an OAuth
    // refresh failure — it lacks the "claude-cli" provider prefix.
    const otherProviderMessage =
      "Provider openai failed: Failed to authenticate. API Error: 401 Unauthorized";
    expect(classifyOAuthRefreshFailure(otherProviderMessage)).toBeNull();
  });
});

type LoopbackHandler = (request: IncomingMessage, response: ServerResponse) => void;

async function withLoopbackServer<T>(
  handler: LoopbackHandler,
  run: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

async function fetchClaudeCliOAuthProbe(baseUrl: string): Promise<{ ok: true; body: unknown }> {
  const response = await fetch(`${baseUrl}/oauth-expiry`);
  const body = await response.text();
  if (!response.ok) {
    const rawError = body.trim() || `HTTP ${response.status}`;
    const failure = new FailoverError(rawError, {
      reason: "auth",
      provider: "claude-cli",
      model: "claude-sonnet-4-20250514",
      status: response.status,
      rawError,
    });
    const oauthFailure =
      classifyOAuthRefreshFailureError(failure) ?? classifyOAuthRefreshFailure(failure.message);
    if (oauthFailure?.reason) {
      const command = buildOAuthRefreshFailureLoginCommand(oauthFailure.provider);
      throw new Error(
        `Model login expired on the gateway for ${oauthFailure.provider}. Re-auth with \`${command}\`, then try again.`,
        { cause: failure },
      );
    }
    throw failure;
  }
  return { ok: true, body: JSON.parse(body) };
}

describe("claude-cli oauth-expiry — real HTTP server (no fetch mock)", () => {
  it("throws a re-auth hint when the server returns 401", async () => {
    await withLoopbackServer(
      (_request, response) => {
        response.writeHead(401, { "content-type": "text/plain" });
        response.end("Failed to authenticate. API Error: 401 Invalid authentication credentials");
      },
      async (baseUrl) => {
        await expect(fetchClaudeCliOAuthProbe(baseUrl)).rejects.toThrow(
          "Re-auth with `openclaw models auth login --provider anthropic --method cli`",
        );
      },
    );
  });

  it("works normally when the server returns 200", async () => {
    await withLoopbackServer(
      (_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ provider: "claude-cli", ok: true }));
      },
      async (baseUrl) => {
        await expect(fetchClaudeCliOAuthProbe(baseUrl)).resolves.toEqual({
          ok: true,
          body: { provider: "claude-cli", ok: true },
        });
      },
    );
  });
});
