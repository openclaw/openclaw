import type { OAuthCredential } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loginRadiusOAuth, refreshRadiusOAuthCredential } from "./oauth.js";
import { authContext as context, devicePayload, tokenPayload } from "./test-support.js";

const { guardedFetch, release } = vi.hoisted(() => ({
  guardedFetch: vi.fn(),
  release: vi.fn(async () => {}),
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({ fetchWithSsrFGuard: guardedFetch }));

const requestAt = (index: number) => guardedFetch.mock.calls[index]![0];

const reply = (payload: unknown, status = 200) =>
  guardedFetch.mockResolvedValueOnce({
    response: Response.json(payload, { status }),
    release,
  });

const device = (overrides: Record<string, unknown> = {}) =>
  reply({ ...devicePayload, ...overrides });

const token = (overrides: Record<string, unknown> = {}) => reply({ ...tokenPayload, ...overrides });

const formAt = (index: number) => Object.fromEntries(requestAt(index).init.body);
let defaults: ReturnType<typeof context>;

async function rejectLogin(message: string, ms = 1_000, ctx = defaults.ctx) {
  const rejection = expect(loginRadiusOAuth(ctx)).rejects.toThrow(message);
  await vi.advanceTimersByTimeAsync(ms);
  await rejection;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-11T12:00:00Z"));
  guardedFetch.mockReset();
  release.mockClear();
  defaults = context();
});

afterEach(() => vi.useRealTimers());

it("accepts the fractional polling interval returned by the live Radius service", async () => {
  device({ interval: 0.1 });
  token();
  const result = loginRadiusOAuth(defaults.ctx).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.advanceTimersByTimeAsync(99);
  expect(guardedFetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await expect(result).resolves.toMatchObject({ value: { access: "access-test" } });
  expect(guardedFetch).toHaveBeenCalledTimes(2);
});

it("pairs through the native device grant and slows subsequent polls after slow_down", async () => {
  device();
  reply({ error: "authorization_pending" }, 400);
  reply({ error: "slow_down" }, 400);
  token();
  const { ctx, progress } = defaults;
  const result = loginRadiusOAuth(ctx);

  await vi.advanceTimersByTimeAsync(0);
  expect(ctx.prompter.note).toHaveBeenCalledWith(
    expect.stringContaining("ABCD-EFGH"),
    "Radius sign-in",
  );
  expect(ctx.openUrl).toHaveBeenCalledWith("https://radius.earendil.com/device");
  expect(guardedFetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(guardedFetch).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(5_999);
  expect(guardedFetch).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(1);
  await expect(result).resolves.toEqual({
    access: "access-test",
    refresh: "refresh-test",
    expires: Date.now() + 3_540_000,
  });
  expect(requestAt(0)).toMatchObject({
    url: "https://radius.pi.dev/v1/oauth/device",
    requireHttps: true,
    policy: { hostnameAllowlist: ["radius.pi.dev"] },
  });
  expect(formAt(0)).toEqual({
    client_id: "pi-gateway",
    scope: "gateway offline_access",
  });
  expect(requestAt(1).url).toBe("https://radius.pi.dev/v1/oauth/token");
  expect(formAt(1)).toEqual({
    client_id: "pi-gateway",
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: "device-secret",
  });
  expect(release).toHaveBeenCalledTimes(4);
  expect(progress.stop).toHaveBeenCalledWith("Radius sign-in complete");
});

it.each([
  ["access_denied", "denied"],
  ["expired_token", "expired"],
  ["server_error", "HTTP 400"],
])("terminates on %s without leaking the server description", async (code, message) => {
  device();
  reply({ error: code, error_description: "secret-response-value" }, 400);
  await rejectLogin(message);
  expect(guardedFetch).toHaveBeenCalledTimes(2);
  expect(defaults.progress.stop).toHaveBeenCalledWith("Radius sign-in stopped");
});

it("stops at device expiry before issuing a late poll", async () => {
  device({ expires_in: 2, interval: 5 });
  await rejectLogin("expired", 2_000);
  expect(guardedFetch).toHaveBeenCalledTimes(1);
});

it("cancels the wait and clears its timer without another token request", async () => {
  device();
  const abort = new AbortController();
  const { ctx, progress } = context({ signal: abort.signal });
  const rejection = expect(loginRadiusOAuth(ctx)).rejects.toThrow(/abort/i);
  await vi.advanceTimersByTimeAsync(0);
  abort.abort();
  await rejection;
  expect(vi.getTimerCount()).toBe(0);
  expect(guardedFetch).toHaveBeenCalledTimes(1);
  expect(progress.stop).toHaveBeenCalledWith("Radius sign-in stopped");
});

it.each(["note", "device", "token"])("rechecks authority at %s", async (boundary) => {
  let current = true;
  const { ctx } = context({
    assertCurrent: () => {
      if (!current) {
        throw new Error("Login revoked");
      }
    },
  });
  const send = vi.fn();
  if (boundary !== "device") {
    device();
  }
  if (boundary === "note") {
    ctx.prompter.note = async () => {
      current = false;
    };
  } else {
    guardedFetch.mockImplementationOnce(async (params: { beforeRequest?: () => void }) => {
      await Promise.resolve();
      current = false;
      params.beforeRequest?.();
      send();
      throw new Error("Request was sent after authority was revoked");
    });
  }
  await rejectLogin("Login revoked", 1_000, ctx);
  expect(send).not.toHaveBeenCalled();
  if (boundary === "note") {
    expect(ctx.openUrl).not.toHaveBeenCalled();
    expect(guardedFetch).toHaveBeenCalledTimes(1);
  }
});

it.each([
  { device_code: "" },
  { expires_in: -1 },
  { interval: 0 },
  { verification_uri: "javascript:alert(1)" },
  { verification_uri: "https://example.com/device" },
])("rejects malformed pairing data before browser effects: %j", async (invalid) => {
  device(invalid);
  const { ctx } = defaults;
  await expect(loginRadiusOAuth(ctx)).rejects.toThrow(/invalid/);
  expect(ctx.openUrl).not.toHaveBeenCalled();
  expect(ctx.prompter.note).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledTimes(1);
});

it.each([undefined, "rotated-refresh"])("refresh rotation: %s", async (refreshToken) => {
  token({ refresh_token: refreshToken });
  const credential: OAuthCredential = {
    type: "oauth",
    provider: "radius",
    access: "old-access",
    refresh: "old-refresh",
    expires: 1,
    email: "test@example.com",
  };
  await expect(refreshRadiusOAuthCredential(credential)).resolves.toEqual({
    ...credential,
    access: "access-test",
    refresh: refreshToken ?? "old-refresh",
    expires: Date.now() + 3_540_000,
  });
  expect(formAt(0)).toEqual({
    client_id: "pi-gateway",
    grant_type: "refresh_token",
    refresh_token: "old-refresh",
  });
  expect(release).toHaveBeenCalledTimes(1);
});

it.each([{ access_token: "" }, { refresh_token: "" }, { expires_in: "invalid" }])(
  "rejects malformed token data: %j",
  async (invalid) => {
    device();
    token(invalid);
    await rejectLogin("invalid credentials");
    expect(release).toHaveBeenCalledTimes(2);
  },
);
