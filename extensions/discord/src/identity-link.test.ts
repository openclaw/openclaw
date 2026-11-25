import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, expect, it, vi } from "vitest";
import { discordIdentityLink } from "./identity-link.js";
import { fetchDiscordJson } from "./oauth-http.js";

// Provider boundary: the real adapter owns OAuth fields and immutable identity parsing.
vi.mock("./oauth-http.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./oauth-http.js")>()),
  fetchDiscordJson: vi.fn(),
}));
const cfg: OpenClawConfig = {
  channels: {
    discord: {
      activities: { applicationId: "123456789012345678", clientSecret: "test-client-secret" },
    },
  },
};
beforeEach(() => {
  vi.mocked(fetchDiscordJson).mockReset();
});
it("uses identify-only authorization and verifies the authenticated user before returning an immutable ID", async () => {
  const adapter = (await discordIdentityLink.prepare(cfg, "default"))!;
  const redirectUri = "https://gateway.example/oauth/provider/callback";
  const url = new URL(adapter.authorizationUrl({ state: "one-use-state", redirectUri }));
  expect(url.origin).toBe("https://discord.com");
  expect(url.searchParams.get("scope")).toBe("identify");
  expect(url.searchParams.get("state")).toBe("one-use-state");
  vi.mocked(fetchDiscordJson)
    .mockResolvedValueOnce({ ok: true, body: { access_token: "test-access-token" } })
    .mockResolvedValueOnce({
      ok: true,
      body: { id: "987654321098765432", username: "mutable-name" },
    });
  const assertCurrent = vi.fn();
  await expect(
    adapter.exchange({
      code: "one-use-code",
      redirectUri,
      signal: new AbortController().signal,
      assertCurrent,
    }),
  ).resolves.toEqual({ senderId: "987654321098765432" });
  const tokenBody = vi.mocked(fetchDiscordJson).mock.calls[0]![0].init.body;
  if (!(tokenBody instanceof URLSearchParams)) {
    throw new Error("Expected a URL-encoded OAuth token request body");
  }
  expect(tokenBody.get("redirect_uri")).toBe(redirectUri);
  expect(vi.mocked(fetchDiscordJson).mock.calls[1]![0]).toMatchObject({
    url: "https://discord.com/api/v10/users/@me",
    init: { headers: { Authorization: "Bearer test-access-token" } },
  });
  expect(adapter.isCurrent({ channels: { discord: { enabled: false } } })).toBe(false);
  expect(await discordIdentityLink.prepare(cfg, "missing")).toBeUndefined();
});
it("rejects failed exchange, bots, and unverified mutable usernames", async () => {
  const adapter = (await discordIdentityLink.prepare(cfg, "default"))!;
  for (const user of [{ id: "987654321098765432", bot: true }, { username: "someone" }]) {
    vi.mocked(fetchDiscordJson)
      .mockResolvedValueOnce({ ok: true, body: { access_token: "test" } })
      .mockResolvedValueOnce({ ok: true, body: user });
    await expect(
      adapter.exchange({
        code: "code",
        redirectUri: "https://gateway.example/callback",
        signal: new AbortController().signal,
        assertCurrent() {},
      }),
    ).rejects.toThrow("personal account");
  }
});
