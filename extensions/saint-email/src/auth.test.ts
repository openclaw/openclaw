import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedSaintEmailAccount } from "./types.js";
import { invalidateGmailAccessToken, resolveGmailAccessToken } from "./auth.js";

function createOauthAccount(
  overrides?: Partial<ResolvedSaintEmailAccount>,
): ResolvedSaintEmailAccount {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  return {
    accountId: "default",
    enabled: true,
    address: "bot@example.com",
    userId: "me",
    accessToken: undefined,
    oauth2: {
      serviceAccountEmail: "svc@example.iam.gserviceaccount.com",
      privateKey: pem,
      tokenUri: "https://oauth2.googleapis.com/token",
      scopes: ["https://www.googleapis.com/auth/gmail.send"],
      subject: "bot@example.com",
    },
    dmPolicy: "allowlist",
    allowFrom: [],
    pollIntervalSec: 60,
    pollQuery: "in:inbox",
    maxPollResults: 10,
    maxAttachmentMb: 20,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("saint-email oauth2 token resolution", () => {
  it("uses static access token without token exchange", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const account = createOauthAccount({ accessToken: " static-token " });

    const resolved = await resolveGmailAccessToken({ account });
    expect(resolved).toEqual({ token: "static-token", source: "static" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("exchanges and caches service-account token", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ access_token: "oauth-token", expires_in: 3600 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const account = createOauthAccount();

    const first = await resolveGmailAccessToken({ account });
    const second = await resolveGmailAccessToken({ account });

    expect(first).toEqual({ token: "oauth-token", source: "oauth2" });
    expect(second).toEqual({ token: "oauth-token", source: "oauth2" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    invalidateGmailAccessToken(account);
    await resolveGmailAccessToken({ account });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
