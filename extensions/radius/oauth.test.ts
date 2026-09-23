import type { ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import type { OAuthCredential } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loginRadiusOAuth, refreshRadiusOAuthCredential } from "./oauth.js";

const { guardedFetch, release } = vi.hoisted(() => ({
  guardedFetch: vi.fn(),
  release: vi.fn(async () => {}),
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({ fetchWithSsrFGuard: guardedFetch }));

function requestAt(index: number) {
  const call = guardedFetch.mock.calls[index];
  if (!call) {
    throw new Error(`Expected Radius OAuth request ${index}`);
  }
  return call[0];
}

function reply(payload: unknown, status = 200) {
  guardedFetch.mockResolvedValueOnce({
    response: new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
    release,
  });
}

function device(overrides: Record<string, unknown> = {}) {
  reply({
    device_code: "device-secret",
    user_code: "ABCD-EFGH",
    verification_uri: "https://radius.earendil.com/device",
    expires_in: 120,
    interval: 1,
    ...overrides,
  });
}

function token(overrides: Record<string, unknown> = {}) {
  reply({
    access_token: "access-test",
    refresh_token: "refresh-test",
    expires_in: 3600,
    ...overrides,
  });
}

function context(overrides: Partial<ProviderAuthContext> = {}) {
  const progress = { update: vi.fn(), stop: vi.fn() };
  const ctx: ProviderAuthContext = {
    config: {},
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    prompter: {
      intro: vi.fn(async () => {}),
      outro: vi.fn(async () => {}),
      note: vi.fn(async () => {}),
      select: async () => {
        throw new Error("Unexpected selection");
      },
      multiselect: async () => {
        throw new Error("Unexpected selection");
      },
      text: async () => {
        throw new Error("Unexpected prompt");
      },
      confirm: async () => {
        throw new Error("Unexpected confirmation");
      },
      progress: vi.fn(() => progress),
    },
    isRemote: false,
    openUrl: vi.fn(async () => {}),
    oauth: {
      createVpsAwareHandlers: () => {
        throw new Error("Unexpected callback flow");
      },
    },
    ...overrides,
  };
  return { ctx, progress };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-11T12:00:00Z"));
  guardedFetch.mockReset();
  release.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Radius OAuth", () => {
  it("accepts the fractional polling interval returned by the live Radius service", async () => {
    device({ interval: 0.1 });
    token();
    const { ctx } = context();
    const result = loginRadiusOAuth(ctx).then(
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
    const { ctx, progress } = context();
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
    expect(Object.fromEntries(requestAt(0).init.body)).toEqual({
      client_id: "pi-gateway",
      scope: "gateway offline_access",
    });
    expect(requestAt(1).url).toBe("https://radius.pi.dev/v1/oauth/token");
    expect(Object.fromEntries(requestAt(1).init.body)).toEqual({
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
    const { ctx, progress } = context();
    const rejection = expect(loginRadiusOAuth(ctx)).rejects.toThrow(message);
    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
    expect(guardedFetch).toHaveBeenCalledTimes(2);
    expect(progress.stop).toHaveBeenCalledWith("Radius sign-in stopped");
  });

  it("stops at device expiry before issuing a late poll", async () => {
    device({ expires_in: 2, interval: 5 });
    const { ctx } = context();
    const rejection = expect(loginRadiusOAuth(ctx)).rejects.toThrow("expired");
    await vi.advanceTimersByTimeAsync(2_000);
    await rejection;
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

  it("rechecks authority after showing the device code before opening the browser", async () => {
    device();
    let current = true;
    const { ctx } = context({
      assertCurrent: () => {
        if (!current) {
          throw new Error("Login revoked");
        }
      },
    });
    ctx.prompter.note = async () => {
      current = false;
    };
    await expect(loginRadiusOAuth(ctx)).rejects.toThrow("Login revoked");
    expect(ctx.openUrl).not.toHaveBeenCalled();
    expect(guardedFetch).toHaveBeenCalledTimes(1);
  });

  it.each(["device", "token"])(
    "rechecks authority after transport preparation before the %s request",
    async (endpoint) => {
      if (endpoint === "token") {
        device();
      }
      let current = true;
      const send = vi.fn();
      guardedFetch.mockImplementationOnce(async (params: { beforeRequest?: () => void }) => {
        await Promise.resolve();
        current = false;
        params.beforeRequest?.();
        send();
        throw new Error("Request was sent after authority was revoked");
      });
      const { ctx } = context({
        assertCurrent: () => {
          if (!current) {
            throw new Error("Login revoked");
          }
        },
      });
      const rejection = expect(loginRadiusOAuth(ctx)).rejects.toThrow("Login revoked");
      await vi.advanceTimersByTimeAsync(1_000);
      await rejection;
      expect(send).not.toHaveBeenCalled();
    },
  );

  it.each([
    { device_code: "" },
    { expires_in: -1 },
    { interval: 0 },
    { verification_uri: "javascript:alert(1)" },
    { verification_uri: "https://example.com/device" },
  ])("rejects malformed pairing data before browser effects: %j", async (invalid) => {
    device(invalid);
    const { ctx } = context();
    await expect(loginRadiusOAuth(ctx)).rejects.toThrow(/invalid/);
    expect(ctx.openUrl).not.toHaveBeenCalled();
    expect(ctx.prompter.note).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, "rotated-refresh"])(
    "refreshes while retaining metadata and handling rotation %s",
    async (refreshToken) => {
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
      expect(Object.fromEntries(requestAt(0).init.body)).toEqual({
        client_id: "pi-gateway",
        grant_type: "refresh_token",
        refresh_token: "old-refresh",
      });
      expect(release).toHaveBeenCalledTimes(1);
    },
  );

  it.each([{ access_token: "" }, { refresh_token: "" }, { expires_in: "invalid" }])(
    "rejects malformed token data: %j",
    async (invalid) => {
      device();
      token(invalid);
      const { ctx } = context();
      const rejection = expect(loginRadiusOAuth(ctx)).rejects.toThrow("invalid credentials");
      await vi.advanceTimersByTimeAsync(1_000);
      await rejection;
      expect(release).toHaveBeenCalledTimes(2);
    },
  );
});
