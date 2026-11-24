import type { ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import type { OAuthCredential } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loginOpencodeConsole, refreshOpencodeConsoleCredential } from "./console-oauth.js";

const { guardedFetch, release } = vi.hoisted(() => ({
  guardedFetch: vi.fn(),
  release: vi.fn(async () => {}),
}));
// mock-isolation: every Console request is answered here; the real guarded fetch would reach opencode.ai.
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({ fetchWithSsrFGuard: guardedFetch }));

// Console's real device answer: a path on its own origin, not an absolute URL.
const devicePayload = {
  device_code: "device-secret",
  user_code: "ABCD-EFGH",
  verification_uri: "/console/device",
  verification_uri_complete: "/console/device?user_code=ABCD-EFGH&client_id=openclaw",
  expires_in: 600,
  interval: 1,
};
const tokenPayload = {
  access_token: "access-test",
  refresh_token: "refresh-test",
  expires_in: 3600,
  org_id: "wrk_test",
};
const reply = (payload: unknown, status = 200) =>
  guardedFetch.mockResolvedValueOnce({ response: Response.json(payload, { status }), release });
const request = (index: number) => guardedFetch.mock.calls[index]![0];
const body = (index: number) => JSON.parse(request(index).init.body as string);

function context() {
  const progress = { update: vi.fn(), stop: vi.fn() };
  const unexpected = async () => {
    throw new Error("OpenCode Console sign-in must not ask for text or selection");
  };
  const ctx: ProviderAuthContext = {
    config: {},
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    prompter: {
      intro: vi.fn(async () => {}),
      outro: vi.fn(async () => {}),
      note: vi.fn(async () => {}),
      select: unexpected,
      multiselect: unexpected,
      text: unexpected,
      confirm: unexpected,
      progress: vi.fn(() => progress),
    },
    isRemote: false,
    openUrl: vi.fn(async () => {}),
    oauth: {
      createVpsAwareHandlers: () => {
        throw new Error("OpenCode Console sign-in must use its device grant");
      },
    },
  };
  return { ctx, progress };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-21T04:00:00Z"));
  guardedFetch.mockReset();
  release.mockClear();
});
afterEach(() => vi.useRealTimers());

it("signs in as OpenClaw's own Console client on Console's own origin, backing off on slow_down", async () => {
  reply(devicePayload);
  reply({ error: "authorization_pending" }, 400);
  reply({ error: "slow_down" }, 400);
  reply(tokenPayload);
  const { ctx, progress } = context();

  const result = loginOpencodeConsole(ctx);
  await vi.advanceTimersByTimeAsync(0);
  expect(ctx.openUrl).toHaveBeenCalledWith(
    "https://opencode.ai/console/device?user_code=ABCD-EFGH&client_id=openclaw",
  );
  await vi.advanceTimersByTimeAsync(2_000);
  expect(guardedFetch).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(5_999);
  expect(guardedFetch).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(1);

  await expect(result).resolves.toEqual({
    access: "access-test",
    refresh: "refresh-test",
    expires: Date.now() + 3_300_000,
  });
  expect(request(0)).toMatchObject({
    url: "https://opencode.ai/console/auth/device/code",
    requireHttps: true,
    policy: { hostnameAllowlist: ["opencode.ai"] },
  });
  expect(body(0)).toEqual({ client_id: "openclaw", supports_org_scope: true });
  expect(request(3).url).toBe("https://opencode.ai/console/auth/device/token");
  expect(body(3)).toEqual({
    client_id: "openclaw",
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: "device-secret",
  });
  expect(progress.stop).toHaveBeenCalledWith("OpenCode Console sign-in complete");
});

it("refreshes with the stored refresh token and keeps the rotated one, never the old", async () => {
  reply({ ...tokenPayload, refresh_token: "rotated-refresh" });
  const credential: OAuthCredential = {
    type: "oauth",
    provider: "opencode-go",
    access: "old-access",
    refresh: "old-refresh",
    expires: 1,
  };

  await expect(refreshOpencodeConsoleCredential(credential)).resolves.toEqual({
    ...credential,
    access: "access-test",
    refresh: "rotated-refresh",
    expires: Date.now() + 3_300_000,
  });
  expect(body(0)).toEqual({
    client_id: "openclaw",
    grant_type: "refresh_token",
    refresh_token: "old-refresh",
  });
});
