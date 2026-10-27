import { afterEach, describe, expect, it, vi } from "vitest";
import { hasUsableOAuthCredential } from "./credential-state.js";
import { refreshOAuthCredential } from "./oauth-provider-operations.js";
import type { OAuthCredential } from "./types.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("refreshOAuthCredential", () => {
  it("refreshes an Anthropic credential before raw expiry when the manager requests rotation", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "rotated-access",
          refresh_token: "rotated-refresh",
          expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const credential: OAuthCredential = {
      type: "oauth",
      provider: "anthropic",
      access: "stale-access",
      refresh: "stale-refresh",
      expires: Date.now() + 4 * 60 * 1000,
    };

    expect(hasUsableOAuthCredential(credential)).toBe(false);
    const refreshed = await refreshOAuthCredential(credential);

    expect(fetch).toHaveBeenCalledOnce();
    const requestBody = fetch.mock.calls[0]?.[1]?.body;
    expect(typeof requestBody === "string" ? JSON.parse(requestBody) : requestBody).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "stale-refresh",
    });
    expect(refreshed).toMatchObject({
      access: "rotated-access",
      refresh: "rotated-refresh",
    });
  });
});
