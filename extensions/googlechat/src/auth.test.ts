import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { GOOGLE_CHAT_SCOPE, getGoogleChatAccessToken } from "./auth.js";

describe("getGoogleChatAccessToken", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses manual service-account JWT exchange and caches the token", async () => {
    const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      const params = new URLSearchParams(body);
      expect(params.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
      const assertion = params.get("assertion");
      expect(assertion).toBeTruthy();

      const parts = assertion!.split(".");
      expect(parts).toHaveLength(3);
      const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
      expect(payload.iss).toBe("bot@example.com");
      expect(payload.scope).toBe(GOOGLE_CHAT_SCOPE);
      expect(payload.aud).toBe("https://oauth2.googleapis.com/token");
      expect(payload.exp).toBeGreaterThan(payload.iat);

      return new Response(JSON.stringify({ access_token: "token-123", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const account = {
      accountId: "default",
      enabled: true,
      credentialSource: "inline",
      credentials: {
        client_email: "bot@example.com",
        private_key: privateKeyPem,
        token_uri: "https://oauth2.googleapis.com/token",
      },
      config: {},
    } as ResolvedGoogleChatAccount;

    await expect(getGoogleChatAccessToken(account)).resolves.toBe("token-123");
    await expect(getGoogleChatAccessToken(account)).resolves.toBe("token-123");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
