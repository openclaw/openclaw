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
  guardedFetch.mockResolvedValueOnce({ response: Response.json(payload, { status }), release });

const device = (overrides: Record<string, unknown> = {}) =>
  reply({ ...devicePayload, ...overrides });

const token = (overrides: Record<string, unknown> = {}) => reply({ ...tokenPayload, ...overrides });

const expectForm = (index: number, form: string) =>
  expect(Object.fromEntries(requestAt(index).init.body)).toEqual({
    client_id: "pi-gateway",
    ...Object.fromEntries(new URLSearchParams(form)),
  });
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

it("pairs with fractional polling intervals and slows subsequent polls after slow_down", async () => {
  device({ interval: 0.1 });
  reply({ error: "authorization_pending" }, 400);
  reply({ error: "slow_down" }, 400);
  token();
  const { ctx, progress } = defaults;
  const result = loginRadiusOAuth(ctx);

  await vi.advanceTimersByTimeAsync(0);
  expect(vi.mocked(ctx.prompter.note).mock.calls[0]?.[0]).toContain("ABCD-EFGH");
  expect(ctx.openUrl).toHaveBeenCalledWith("https://radius.earendil.com/device");
  for (const [elapsed, calls] of [
    [99, 1],
    [1, 2],
    [100, 3],
    [5_099, 3],
  ] as const) {
    await vi.advanceTimersByTimeAsync(elapsed);
    expect(guardedFetch).toHaveBeenCalledTimes(calls);
  }
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
  expectForm(0, "scope=gateway+offline_access");
  expect(requestAt(1).url).toBe("https://radius.pi.dev/v1/oauth/token");
  expectForm(
    1,
    "grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=device-secret",
  );
  expect(release).toHaveBeenCalledTimes(4);
  expect(progress.stop).toHaveBeenCalledWith("Radius sign-in complete");
});

it.each([
  ["access_denied", "denied"],
  ["expired_token", "expired"],
  ["server_error", "HTTP 400"],
  [undefined, "expired"],
])("terminates on %s without leaking the server description", async (code, message) => {
  device(code ? {} : { expires_in: 2, interval: 5 });
  if (code) {
    reply({ error: code, error_description: "secret-response-value" }, 400);
  }
  await rejectLogin(message, code ? 1_000 : 2_000);
  expect(guardedFetch).toHaveBeenCalledTimes(code ? 2 : 1);
  expect(defaults.progress.stop).toHaveBeenCalledWith("Radius sign-in stopped");
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
      throw new Error("Request was sent after authority was revoked");
    });
  }
  await rejectLogin("Login revoked", 1_000, ctx);
  if (boundary === "note") {
    expect(ctx.openUrl).not.toHaveBeenCalled();
    expect(guardedFetch).toHaveBeenCalledTimes(1);
  }
});

it.each([
  ["device", { device_code: "" }],
  ["device", { expires_in: -1 }],
  ["device", { interval: 0 }],
  ["device", { verification_uri: "javascript:alert(1)" }],
  ["device", { verification_uri: "https://example.com/device" }],
  ["token", { access_token: "" }],
  ["token", { refresh_token: "" }],
  ["token", { expires_in: "invalid" }],
] as const)("rejects malformed %s data: %j", async (phase, invalid) => {
  device(phase === "device" ? invalid : {});
  if (phase === "token") {
    token(invalid);
  }
  const { ctx } = defaults;
  await rejectLogin(phase === "device" ? "invalid" : "invalid credentials");
  if (phase === "device") {
    expect(ctx.openUrl).not.toHaveBeenCalled();
    expect(ctx.prompter.note).not.toHaveBeenCalled();
  }
  expect(release).toHaveBeenCalledTimes(phase === "device" ? 1 : 2);
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
  expectForm(0, "grant_type=refresh_token&refresh_token=old-refresh");
  expect(release).toHaveBeenCalledTimes(1);
});
