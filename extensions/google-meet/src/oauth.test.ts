import { createServer, type Server } from "node:http";
import * as providerAuthRuntime from "openclaw/plugin-sdk/provider-auth-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveGoogleMeetAccessToken, waitForGoogleMeetAuthCode } from "./oauth.js";

async function occupyPort(port: number): Promise<Server | null> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "localhost", resolve);
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("EADDRINUSE")) {
      return null;
    }
    throw error;
  }
  return server;
}

function mockTokenResponse(response: Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response),
  );
}

const resolveToken = (overrides: Parameters<typeof resolveGoogleMeetAccessToken>[0] = {}) =>
  resolveGoogleMeetAccessToken({
    clientId: "client-id",
    refreshToken: "refresh-token",
    ...overrides,
  });
const waitForCode = (overrides: Partial<Parameters<typeof waitForGoogleMeetAuthCode>[0]>) =>
  waitForGoogleMeetAuthCode({
    state: "state-token",
    manual: false,
    timeoutMs: 60_000,
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth?x=1",
    promptInput: async () => "unused",
    writeLine: () => {},
    ...overrides,
  });

describe("Google Meet OAuth", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("rejects oversized OAuth token responses", async () => {
    mockTokenResponse(
      new Response(new Uint8Array(300 * 1024), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(resolveToken()).rejects.toThrow(
      "Google OAuth token: JSON response exceeds 262144 bytes",
    );
  });

  it("refreshes cached access tokens with Date-invalid expiries", async () => {
    mockTokenResponse(Response.json({ access_token: "refreshed-token", expires_in: 3600 }));
    const tokens = await resolveToken({
      accessToken: "cached-token",
      expiresAt: 8_700_000_000_000_000,
    });

    expect(tokens).toMatchObject({ accessToken: "refreshed-token", refreshed: true });
  });

  it.each([
    ["invalid clock", 8_640_000_000_000_001, Number.MAX_SAFE_INTEGER, 3_600_000],
    ["zero lifetime", 1_780_056_000_000, 0, 1_780_056_000_000],
  ] as const)("bounds token expiry: %s", async (_name, now, expiresIn, expected) => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    mockTokenResponse(Response.json({ access_token: "new-access-token", expires_in: expiresIn }));
    expect((await resolveToken()).expiresAt).toBe(expected);
  });

  it("falls back to manual paste when the local callback port is occupied", async () => {
    const blocker = await occupyPort(8085);
    try {
      const lines: string[] = [];
      const code = await waitForCode({
        promptInput: async () =>
          "http://localhost:8085/oauth2callback?code=auth-code-123&state=state-token",
        writeLine: (message) => lines.push(message),
      });
      expect(code).toBe("auth-code-123");
      expect(lines.some((line) => line.includes("Switching to manual mode"))).toBe(true);
    } finally {
      if (blocker) {
        await new Promise<void>((resolve) => {
          blocker.close(() => resolve());
        });
      }
    }
  });

  it("propagates non-listener callback failures without manual fallback", async () => {
    // Test the SDK rejection without requiring the fixed callback port to be free.
    const timeoutError = new Error("OAuth callback timeout");
    vi.spyOn(providerAuthRuntime, "waitForLocalOAuthCallback").mockRejectedValueOnce(timeoutError);
    const promptInput = vi.fn(async () => "unused");
    await expect(waitForCode({ timeoutMs: 1, promptInput })).rejects.toBe(timeoutError);
    expect(promptInput).not.toHaveBeenCalled();
  });
});
